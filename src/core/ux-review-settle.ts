import { existsSync, readFileSync } from "node:fs";

import type { StageName, TicketRun } from "../domain/types.js";
import { queueStage } from "./admission.js";
import type { ControllerContext } from "./controller-context.js";
import { refreshCounters, requireTicket, requireWave } from "./controller-context.js";
import { checkPlanReview, resolveCrawmakForge } from "./plan-review.js";
import {
  assertTicketTransition,
  assertWaveTransition,
  TICKET_NEXT,
  TICKET_OWNERS,
  WAVE_NEXT,
  WAVE_OWNERS,
} from "./state-machine.js";
import {
  checkUxReview,
  resolveExistingUxSpec,
  resolveMonaWorkspace,
} from "./ux-review.js";

function putTicketStatus(
  ctrl: ControllerContext,
  ticket: {
    waveId: string;
    ticketId: string;
    status: string;
    revision: number;
    owner: string;
    nextAction: string;
    result?: string;
  },
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

function planTextOf(ticket: { planArtifact?: string }): string {
  if (!ticket.planArtifact || !existsSync(ticket.planArtifact)) return "";
  try {
    return readFileSync(ticket.planArtifact, "utf8");
  } catch {
    return "";
  }
}

export function latestPlanAttempt(ctrl: ControllerContext, waveId: string, ticketId: string): number {
  return ctrl.db
    .listStages(waveId)
    .filter((s) => s.ticketId === ticketId && s.stage === "PLAN" && s.status === "SUCCEEDED")
    .reduce((max, s) => Math.max(max, s.attempt), 0);
}

export function hasHopLaunch(
  ctrl: ControllerContext,
  waveId: string,
  ticketId: string,
  type: string,
  planAttempt: number,
): boolean {
  return ctrl.db.listEvents(waveId).some((ev) => {
    if (ev.type !== type) return false;
    try {
      const p = JSON.parse(ev.payloadJson) as { ticketId?: string; planAttempt?: number };
      return p.ticketId === ticketId && p.planAttempt === planAttempt;
    } catch {
      return false;
    }
  });
}

export function openStageOutbox(
  ctrl: ControllerContext,
  waveId: string,
  ticketId: string,
  stage: StageName,
): boolean {
  return ctrl.db.listOutbox(waveId).some(
    (item) =>
      item.ticketId === ticketId &&
      item.stage === stage &&
      item.state !== "SETTLED" &&
      item.state !== "FAILED",
  );
}

export function stageBusy(
  ctrl: ControllerContext,
  waveId: string,
  ticketId: string,
  stage: StageName,
): boolean {
  return ctrl.db
    .listStages(waveId)
    .filter((s) => s.ticketId === ticketId && s.stage === stage)
    .some((s) => s.status === "PENDING" || s.status === "RUNNING");
}

function uxReviseCount(ctrl: ControllerContext, waveId: string, ticketId: string): number {
  return ctrl.db.listEvents(waveId).filter((ev) => {
    if (ev.type !== "ux_review_revise") return false;
    try {
      return (JSON.parse(ev.payloadJson) as { ticketId?: string }).ticketId === ticketId;
    } catch {
      return false;
    }
  }).length;
}

export function crawmakSatisfiedForHop(
  ctrl: ControllerContext,
  ticket: TicketRun,
  planAttempt: number,
): boolean {
  if (ticket.planReviewSkip === true) return true;
  if (planAttempt <= 0 || !hasHopLaunch(ctrl, ticket.waveId, ticket.ticketId, "plan_review_launch", planAttempt)) {
    return false;
  }
  const wave = requireWave(ctrl, ticket.waveId);
  const review = checkPlanReview({
    forgeRoot: resolveCrawmakForge({ explicit: ctrl.forgeRoot, fromRepo: wave.repoPath }),
    ticketId: ticket.ticketId,
  });
  return review.ok && (review.verdict === "approve" || review.verdict === "approve-with-conditions");
}

function persistSpec(ctrl: ControllerContext, ticket: TicketRun): string | undefined {
  const wave = requireWave(ctrl, ticket.waveId);
  const resolved = resolveExistingUxSpec({
    frozenPath: ticket.uxSpecPath,
    planText: planTextOf(ticket),
    searchRoots: [ticket.implWorktree, wave.repoPath],
  });
  if (resolved && resolved !== ticket.uxSpecPath) {
    const live = requireTicket(ctrl, ticket.waveId, ticket.ticketId);
    live.uxSpecPath = resolved;
    ctrl.db.putTicket(live);
  }
  return resolved;
}

export async function queueMissingUxReviews(ctrl: ControllerContext, waveId: string): Promise<void> {
  const wave = requireWave(ctrl, waveId);
  if (wave.status !== "AWAITING_PLAN_GATE") return;
  for (const ticket of ctrl.db.listTickets(waveId)) {
    if (ticket.status !== "PLAN_REVIEW" || ticket.needsUx !== true) continue;
    if (openStageOutbox(ctrl, waveId, ticket.ticketId, "UX_REVIEW")) continue;
    if (stageBusy(ctrl, waveId, ticket.ticketId, "UX_REVIEW")) continue;
    const planAttempt = latestPlanAttempt(ctrl, waveId, ticket.ticketId);
    if (planAttempt <= 0) continue;
    if (hasHopLaunch(ctrl, waveId, ticket.ticketId, "ux_review_launch", planAttempt)) continue;
    if (!crawmakSatisfiedForHop(ctrl, ticket, planAttempt)) continue;
    const mona = resolveMonaWorkspace({ explicit: ctrl.monaRoot });
    if (!mona) {
      if (ticket.result !== "missing_mona") putTicketStatus(ctrl, ticket, "PLAN_REVIEW", "missing_mona");
      continue;
    }
    if (!persistSpec(ctrl, ticket)) {
      if (ticket.result !== "missing_ux_spec") putTicketStatus(ctrl, ticket, "PLAN_REVIEW", "missing_ux_spec");
      continue;
    }
    ctrl.db.insertEvent({
      eventId: `${waveId}:ux-review-launch:${ticket.ticketId}:${ticket.revision}`,
      waveId,
      type: "ux_review_launch",
      payloadJson: JSON.stringify({ ticketId: ticket.ticketId, revision: ticket.revision, planAttempt, mona }),
      createdAt: ctrl.clock.now(),
      revisionApplied: wave.revision,
    });
    await queueStage(ctrl, waveId, ticket.ticketId, "UX_REVIEW");
  }
}

export function admitUxReviewTicket(ctrl: ControllerContext, waveId: string, ticketId: string): boolean {
  const ticket = requireTicket(ctrl, waveId, ticketId);
  if (ticket.status !== "PLAN_REVIEW" || ticket.needsUx !== true) return false;
  const planAttempt = latestPlanAttempt(ctrl, waveId, ticketId);
  if (!crawmakSatisfiedForHop(ctrl, ticket, planAttempt)) return false;
  const mona = resolveMonaWorkspace({ explicit: ctrl.monaRoot });
  const now = ctrl.clock.now();
  const review = checkUxReview({ monaRoot: mona, ticketId });
  if (review.ok && review.verdict === "revise") {
    const cap = ticket.uxReviewReviseCap ?? 1;
    if (uxReviseCount(ctrl, waveId, ticketId) >= cap) {
      putTicketStatus(ctrl, ticket, "FAILED", "ux_review_revise_cap");
      refreshCounters(ctrl, waveId);
      return true;
    }
    ctrl.db.insertEvent({
      eventId: `${waveId}:ux-review-revise:${ticketId}:${ticket.revision}`,
      waveId,
      type: "ux_review_revise",
      payloadJson: JSON.stringify({ ticketId }),
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
    if (!hasHopLaunch(ctrl, waveId, ticketId, "ux_review_launch", planAttempt)) return false;
    putTicketStatus(ctrl, ticket, "APPROVED");
    setWaveRunning(ctrl, waveId, now);
    ctrl.db.insertEvent({
      eventId: `${waveId}:ux-review-admit:${ticketId}:${ticket.revision}`,
      waveId,
      type: "ux_review_admit",
      payloadJson: JSON.stringify({ ticketId, revision: ticket.revision }),
      createdAt: now,
    });
    return true;
  }
  return false;
}

export function needsUxReviewLaunch(ctrl: ControllerContext, waveId: string): boolean {
  return ctrl.db.listTickets(waveId).some((ticket) => {
    if (ticket.status !== "PLAN_REVIEW" || ticket.needsUx !== true) return false;
    const planAttempt = latestPlanAttempt(ctrl, waveId, ticket.ticketId);
    if (!crawmakSatisfiedForHop(ctrl, ticket, planAttempt)) return false;
    return !ctrl.db
      .listOutbox(waveId)
      .some((item) => item.ticketId === ticket.ticketId && item.stage === "UX_REVIEW");
  });
}
