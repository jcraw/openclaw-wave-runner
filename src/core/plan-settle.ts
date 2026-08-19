import type { TicketRun, WaveRecord } from "../domain/types.js";
import type { ControllerContext } from "./controller-context.js";
import { checkPlanArtifact } from "./plan-artifact.js";
import { TICKET_NEXT, TICKET_OWNERS, WAVE_NEXT, WAVE_OWNERS } from "./state-machine.js";

function putTicketStatus(
  ctrl: ControllerContext,
  ticket: TicketRun,
  status: TicketRun["status"],
  result?: string,
): void {
  ticket.status = status;
  if (result !== undefined) ticket.result = result;
  ticket.owner = TICKET_OWNERS[status];
  ticket.nextAction = TICKET_NEXT[status];
  ticket.revision += 1;
  ctrl.db.putTicket(ticket);
}

function setWaveStatus(ctrl: ControllerContext, wave: WaveRecord, status: WaveRecord["status"], now: number): void {
  wave.status = status;
  wave.owner = WAVE_OWNERS[status];
  wave.nextAction = WAVE_NEXT[status];
  wave.revision += 1;
  wave.updatedAt = now;
  ctrl.db.putWave(wave);
}

function ticketHumanHold(ctrl: ControllerContext, wave: WaveRecord, ticket: TicketRun): boolean {
  if (ticket.humanHold === true) return true;
  try {
    const manifest = JSON.parse(wave.manifestJson) as {
      tickets?: Array<{ ticketId: string; humanHold?: boolean }>;
    };
    return (manifest.tickets ?? []).find((x) => x.ticketId === ticket.ticketId)?.humanHold === true;
  } catch {
    return false;
  }
}

function recordAuto(
  ctrl: ControllerContext,
  wave: WaveRecord,
  ticket: TicketRun,
  now: number,
  reason: "policy" | "agent",
): void {
  const already = ctrl.db.listEvents(wave.waveId).some((ev) => {
    if (ev.type !== "plan_gate_auto") return false;
    try {
      const p = JSON.parse(ev.payloadJson) as { ticketId?: string; revision?: number };
      return p.ticketId === ticket.ticketId && p.revision === ticket.revision;
    } catch {
      return false;
    }
  });
  if (already) return;
  ctrl.db.insertEvent({
    eventId: `${wave.waveId}:plan-gate-auto:${ticket.ticketId}:${ticket.revision}`,
    waveId: wave.waveId,
    type: "plan_gate_auto",
    payloadJson: JSON.stringify({
      waveId: wave.waveId,
      ticketId: ticket.ticketId,
      planPath: ticket.planArtifact,
      revision: ticket.revision,
      reason,
    }),
    createdAt: now,
    revisionApplied: wave.revision,
  });
}

export function applyPlanSuccess(
  ctrl: ControllerContext,
  wave: WaveRecord,
  ticket: TicketRun,
  planPath: string | undefined,
  summary: string | undefined,
  now: number,
): void {
  ticket.planArtifact = planPath;
  putTicketStatus(ctrl, ticket, "PLAN_REVIEW");
  const planText = summary ?? "";
  const artifact = checkPlanArtifact({
    planText,
    ticketId: ticket.ticketId,
    verifyCommand: ticket.verifyCommand,
  });
  if (!artifact.ok) {
    putTicketStatus(ctrl, ticket, "FAILED", `plan_artifact: ${artifact.reason}`);
    return;
  }
  const decision = ctrl.policy.decide({ planClass: ticket.planClass, planText });
  if (decision !== "wait") {
    putTicketStatus(ctrl, ticket, "APPROVED");
    recordAuto(ctrl, wave, ticket, now, "policy");
    return;
  }
  if (ticketHumanHold(ctrl, wave, ticket)) {
    setWaveStatus(ctrl, wave, "WAITING_APPROVAL", now);
    return;
  }
  putTicketStatus(ctrl, ticket, "APPROVED");
  recordAuto(ctrl, wave, ticket, now, "agent");
}
