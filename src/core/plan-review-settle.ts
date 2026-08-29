import { existsSync, readFileSync } from "node:fs";

import { queueStage } from "./admission.js";
import type { ControllerContext } from "./controller-context.js";
import { refreshCounters, requireTicket, requireWave } from "./controller-context.js";
import { checkPlanReview, checkPlanStamp, resolveCrawmakForge } from "./plan-review.js";
import {
  admitUxReviewTicket,
  hasHopLaunch,
  latestPlanAttempt,
  needsUxReviewLaunch,
  openStageOutbox,
  queueMissingUxReviews,
  stageBusy,
} from "./ux-review-settle.js";
import {
  assertTicketTransition,
  assertWaveTransition,
  TICKET_NEXT,
  TICKET_OWNERS,
  WAVE_NEXT,
  WAVE_OWNERS,
} from "./state-machine.js";

function putTicketStatus(
  ctrl: ControllerContext,
  ticket: { waveId: string; ticketId: string; status: string; revision: number; owner: string; nextAction: string; result?: string },
  status: "PLAN_REVIEW" | "APPROVED" | "FAILED",
  result?: string,
): void {
  const live = requireTicket(ctrl, ticket.waveId, ticket.ticketId);
  live.status = status;
  if (result !== undefined) live.result = result;
  live.owner = TICKET_OWNERS[status];
  live.nextAction = TICKET_NEXT[status];
  live.revision += 1;
  ctrl.db.putTicket(live);
}

function setWaveRunning(ctrl: ControllerContext, waveId: string, now: number): void {
  const wave = requireWave(ctrl, waveId);
  if (wave.status !== "AWAITING_PLAN_GATE" && wave.status !== "WAITING_APPROVAL") return;
  wave.status = "RUNNING";
  wave.owner = WAVE_OWNERS.RUNNING;
  wave.nextAction = WAVE_NEXT.RUNNING;
  wave.revision += 1;
  wave.updatedAt = now;
  ctrl.db.putWave(wave);
}

export function forgeForWave(ctrl: ControllerContext, waveId: string): string | undefined {
  const wave = requireWave(ctrl, waveId);
  return resolveCrawmakForge({
    explicit: ctrl.forgeRoot,
    fromRepo: wave.repoPath,
  });
}

function planTextOf(ticket: { planArtifact?: string }): string {
  if (!ticket.planArtifact || !existsSync(ticket.planArtifact)) return "";
  try {
    return readFileSync(ticket.planArtifact, "utf8");
  } catch {
    return "";
  }
}

function reviseCount(ctrl: ControllerContext, waveId: string, ticketId: string): number {
  return ctrl.db.listEvents(waveId).filter((ev) => {
    if (ev.type !== "plan_review_revise") return false;
    try {
      return (JSON.parse(ev.payloadJson) as { ticketId?: string }).ticketId === ticketId;
    } catch {
      return false;
    }
  }).length;
}

function hasLaunch(ctrl: ControllerContext, waveId: string, ticketId: string): boolean {
  return ctrl.db.listEvents(waveId).some((ev) => {
    if (ev.type !== "plan_review_launch") return false;
    try {
      return (JSON.parse(ev.payloadJson) as { ticketId?: string }).ticketId === ticketId;
    } catch {
      return false;
    }
  });
}

/** This hop's Crawmak REVIEW has launched and is not still in flight. */
function planReviewHopReady(
  ctrl: ControllerContext,
  waveId: string,
  ticketId: string,
  planAttempt: number,
): boolean {
  if (planAttempt <= 0) return false;
  if (!hasHopLaunch(ctrl, waveId, ticketId, "plan_review_launch", planAttempt)) return false;
  if (openStageOutbox(ctrl, waveId, ticketId, "REVIEW")) return false;
  if (stageBusy(ctrl, waveId, ticketId, "REVIEW")) return false;
  return true;
}

export async function queueMissingPlanReviews(ctrl: ControllerContext, waveId: string): Promise<void> {
  const wave = requireWave(ctrl, waveId);
  if (wave.status !== "AWAITING_PLAN_GATE") return;
  const forge = forgeForWave(ctrl, waveId);
  for (const ticket of ctrl.db.listTickets(waveId)) {
    if (ticket.status !== "PLAN_REVIEW") continue;
    if (ticket.planReviewSkip === true) continue;
    if (openStageOutbox(ctrl, waveId, ticket.ticketId, "REVIEW")) continue;
    if (stageBusy(ctrl, waveId, ticket.ticketId, "REVIEW")) continue;
    const planAttempt = latestPlanAttempt(ctrl, waveId, ticket.ticketId);
    if (planAttempt <= 0) continue;
    if (hasHopLaunch(ctrl, waveId, ticket.ticketId, "plan_review_launch", planAttempt)) continue;
    if (!forge) {
      if (ticket.result !== "missing_forge") putTicketStatus(ctrl, ticket, "PLAN_REVIEW", "missing_forge");
      continue;
    }
    ctrl.db.insertEvent({
      eventId: `${waveId}:plan-review-launch:${ticket.ticketId}:${ticket.revision}`,
      waveId,
      type: "plan_review_launch",
      payloadJson: JSON.stringify({ ticketId: ticket.ticketId, revision: ticket.revision, planAttempt, forge }),
      createdAt: ctrl.clock.now(),
      revisionApplied: wave.revision,
    });
    await queueStage(ctrl, waveId, ticket.ticketId, "REVIEW");
  }
  await queueMissingUxReviews(ctrl, waveId);
}

export function admitPlanReviewTicket(ctrl: ControllerContext, waveId: string, ticketId: string): boolean {
  const ticket = requireTicket(ctrl, waveId, ticketId);
  if (ticket.status !== "PLAN_REVIEW") return false;
  const forge = forgeForWave(ctrl, waveId);
  const now = ctrl.clock.now();
  const launched = hasLaunch(ctrl, waveId, ticketId);
  const stamped = checkPlanStamp(planTextOf(ticket));
  const planAttempt = latestPlanAttempt(ctrl, waveId, ticketId);
  const review = planReviewHopReady(ctrl, waveId, ticketId, planAttempt)
    ? checkPlanReview({ forgeRoot: forge, ticketId })
    : { ok: false as const, reason: "hop_not_ready" };

  if (review.ok && review.verdict === "revise") {
    const cap = ticket.planReviewReviseCap ?? 1;
    if (reviseCount(ctrl, waveId, ticketId) >= cap) {
      putTicketStatus(ctrl, ticket, "FAILED", "plan_review_revise_cap");
      refreshCounters(ctrl, waveId);
      return true;
    }
    ctrl.db.insertEvent({
      eventId: `${waveId}:plan-review-revise:${ticketId}:${ticket.revision}`,
      waveId,
      type: "plan_review_revise",
      payloadJson: JSON.stringify({ ticketId, planAttempt }),
      createdAt: now,
    });
    const live = requireTicket(ctrl, waveId, ticketId);
    const wave = requireWave(ctrl, waveId);
    assertTicketTransition(live.status, "REVISING", wave.cancelRequested);
    live.status = "REVISING";
    live.owner = TICKET_OWNERS.REVISING;
    live.nextAction = TICKET_NEXT.REVISING;
    live.revision += 1;
    ctrl.db.putTicket(live);
    if (wave.status === "AWAITING_PLAN_GATE" || wave.status === "WAITING_APPROVAL") {
      assertWaveTransition(wave.status, "RUNNING", wave.cancelRequested);
      wave.status = "RUNNING";
      wave.owner = WAVE_OWNERS.RUNNING;
      wave.nextAction = WAVE_NEXT.RUNNING;
      wave.revision += 1;
      wave.updatedAt = now;
      ctrl.db.putWave(wave);
    }
    return true;
  }

  if (review.ok && (review.verdict === "approve" || review.verdict === "approve-with-conditions")) {
    if (ticket.needsUx === true) return false;
    putTicketStatus(ctrl, ticket, "APPROVED");
    setWaveRunning(ctrl, waveId, now);
    ctrl.db.insertEvent({
      eventId: `${waveId}:plan-review-admit:${ticketId}:${ticket.revision}`,
      waveId,
      type: "plan_review_admit",
      payloadJson: JSON.stringify({ ticketId, revision: ticket.revision, stamped }),
      createdAt: now,
    });
    return true;
  }

  if (!launched && stamped && ticket.needsUx !== true) {
    putTicketStatus(ctrl, ticket, "APPROVED");
    setWaveRunning(ctrl, waveId, now);
    ctrl.db.insertEvent({
      eventId: `${waveId}:plan-review-admit:${ticketId}:${ticket.revision}:leftover`,
      waveId,
      type: "plan_review_admit",
      payloadJson: JSON.stringify({ ticketId, revision: ticket.revision, leftover: true }),
      createdAt: now,
    });
    return true;
  }
  return false;
}

export function maybeAdmitPlanGate(ctrl: ControllerContext, waveId: string): void {
  const wave = requireWave(ctrl, waveId);
  if (wave.status !== "AWAITING_PLAN_GATE") return;
  for (const ticket of ctrl.db.listTickets(waveId)) {
    if (ticket.status !== "PLAN_REVIEW") continue;
    if (admitPlanReviewTicket(ctrl, waveId, ticket.ticketId)) continue;
    admitUxReviewTicket(ctrl, waveId, ticket.ticketId);
  }
}

export function needsPlanReviewLaunch(ctrl: ControllerContext, waveId: string): boolean {
  if (needsUxReviewLaunch(ctrl, waveId)) return true;
  return ctrl.db.listTickets(waveId).some((ticket) => {
    if (ticket.status !== "PLAN_REVIEW" || ticket.planReviewSkip === true) return false;
    return !ctrl.db.listOutbox(waveId).some((item) => item.ticketId === ticket.ticketId && item.stage === "REVIEW");
  });
}
