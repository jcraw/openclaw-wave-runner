import type { TicketRun, WaveRecord } from "../domain/types.js";
import type { ControllerContext } from "./controller-context.js";
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
  const decision = ctrl.policy.decide({ planClass: ticket.planClass, planText: summary ?? "" });
  if (decision !== "wait") {
    putTicketStatus(ctrl, ticket, "APPROVED");
    return;
  }
  let humanHold = ticket.humanHold === true;
  if (!humanHold) {
    try {
      const manifest = JSON.parse(wave.manifestJson) as {
        tickets?: Array<{ ticketId: string; humanHold?: boolean }>;
      };
      humanHold = (manifest.tickets ?? []).find((x) => x.ticketId === ticket.ticketId)?.humanHold === true;
    } catch {
      // ignore
    }
  }
  if (humanHold) {
    setWaveStatus(ctrl, wave, "WAITING_APPROVAL", now);
    return;
  }
  setWaveStatus(ctrl, wave, "AWAITING_PLAN_GATE", now);
  const wakePayload = {
    waveId: wave.waveId,
    ticketId: ticket.ticketId,
    planPath: planPath ?? ticket.planArtifact,
    revision: ticket.revision,
  };
  const already = ctrl.db.listEvents(wave.waveId).some((ev) => {
    if (ev.type !== "plan_gate_wake") return false;
    try {
      const p = JSON.parse(ev.payloadJson) as { ticketId?: string; revision?: number };
      return p.ticketId === ticket.ticketId && p.revision === ticket.revision;
    } catch {
      return false;
    }
  });
  if (already) return;
  ctrl.db.insertEvent({
    eventId: `${wave.waveId}:plan-gate-wake:${ticket.ticketId}:${ticket.revision}`,
    waveId: wave.waveId,
    type: "plan_gate_wake",
    payloadJson: JSON.stringify(wakePayload),
    createdAt: now,
    revisionApplied: wave.revision,
  });
}
