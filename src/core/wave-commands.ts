import { copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { WaveError } from "../domain/errors.js";
import type { SupervisedStartOptions, WaveView } from "../domain/types.js";
import { markIndeterminate } from "./budget.js";
import type { ControllerContext } from "./controller-context.js";
import {
  eventId as nextEventId,
  inspect,
  mutateWave,
  recordOrThrow,
  refreshCounters,
  requireTicket,
  requireWave,
} from "./controller-context.js";
import {
  assertExpectedRevision,
  assertTicketTransition,
  assertWaveTransition,
  isTerminalTicket,
  isTerminalWave,
  TICKET_NEXT,
  TICKET_OWNERS,
  WAVE_NEXT,
  WAVE_OWNERS,
} from "./state-machine.js";
import { stopForBudget, tickWave } from "./tick.js";
import { assertLaunchAllowed } from "./wave-create.js";

export function freezeWave(
  ctrl: ControllerContext,
  waveId: string,
  eventId: string,
  expectedRevision?: number,
): WaveView {
  return mutateWave(ctrl, waveId, eventId, "freeze", expectedRevision, (wave) => {
    assertWaveTransition(wave.status, "FROZEN", wave.cancelRequested);
    wave.status = "FROZEN";
    wave.owner = WAVE_OWNERS.FROZEN;
    wave.nextAction = WAVE_NEXT.FROZEN;
  });
}

export async function startWave(
  ctrl: ControllerContext,
  waveId: string,
  eventId: string,
  expectedRevision?: number,
  options: SupervisedStartOptions = {},
): Promise<WaveView> {
  const view = inspect(ctrl, waveId);
  assertExpectedRevision(view.wave.revision, expectedRevision);
  assertLaunchAllowed(ctrl, view, options);
  if (isTerminalWave(view.wave.status)) {
    throw new WaveError(`Wave ${waveId} is already terminal (${view.wave.status}).`, "illegal_transition");
  }
  if (view.wave.status === "PAUSED") {
    throw new WaveError("Paused waves resume via resume, not start.", "illegal_transition");
  }
  if (view.wave.status === "DRAFT") freezeWave(ctrl, waveId, nextEventId());
  const afterFreeze = inspect(ctrl, waveId);
  if (afterFreeze.wave.status === "FROZEN") {
    mutateWave(ctrl, waveId, eventId, "start", undefined, (wave) => {
      assertWaveTransition(wave.status, "RUNNING", wave.cancelRequested);
      wave.status = "RUNNING";
      wave.owner = WAVE_OWNERS.RUNNING;
      wave.nextAction = WAVE_NEXT.RUNNING;
      wave.counters = { ...wave.counters, startedAt: wave.counters.startedAt ?? ctrl.clock.now() };
    });
  }
  const current = inspect(ctrl, waveId);
  if (!current.wave.flowId) {
    const flow = await ctrl.workflow.createWave({
      waveId,
      manifestHash: current.wave.manifestHash,
      goal: `Wave ${waveId}`,
      stateJson: { schema: 1, waveId, manifestHash: current.wave.manifestHash },
    });
    ctrl.db.transaction(() => {
      const wave = requireWave(ctrl, waveId);
      wave.flowId = flow.flowId;
      wave.updatedAt = ctrl.clock.now();
      ctrl.db.putWave(wave);
    });
  }
  await tickWave(ctrl, waveId, options);
  return inspect(ctrl, waveId);
}

export function pauseWave(
  ctrl: ControllerContext,
  waveId: string,
  eventId: string,
  expectedRevision?: number,
): WaveView {
  return mutateWave(ctrl, waveId, eventId, "pause", expectedRevision, (wave) => {
    assertWaveTransition(wave.status, "PAUSED", wave.cancelRequested);
    wave.status = "PAUSED";
    wave.owner = WAVE_OWNERS.PAUSED;
    wave.nextAction = WAVE_NEXT.PAUSED;
  });
}

export function resumeWave(
  ctrl: ControllerContext,
  waveId: string,
  eventId: string,
  expectedRevision?: number,
): WaveView {
  return mutateWave(ctrl, waveId, eventId, "resume", expectedRevision, (wave) => {
    assertWaveTransition(wave.status, "RUNNING", wave.cancelRequested);
    wave.status = "RUNNING";
    wave.owner = WAVE_OWNERS.RUNNING;
    wave.nextAction = WAVE_NEXT.RUNNING;
  });
}

export function cancelWave(
  ctrl: ControllerContext,
  waveId: string,
  eventId: string,
  expectedRevision?: number,
): WaveView {
  mutateWave(ctrl, waveId, eventId, "cancel", expectedRevision, (wave) => {
    wave.cancelRequested = true;
    if (!isTerminalWave(wave.status)) {
      assertWaveTransition(wave.status, "CANCELLED", true);
      wave.status = "CANCELLED";
      wave.owner = WAVE_OWNERS.CANCELLED;
      wave.nextAction = WAVE_NEXT.CANCELLED;
    }
  });
  ctrl.db.transaction(() => {
    const now = ctrl.clock.now();
    for (const ticket of ctrl.db.listTickets(waveId)) {
      if (!isTerminalTicket(ticket.status)) {
        ticket.status = "CANCELLED";
        ticket.owner = TICKET_OWNERS.CANCELLED;
        ticket.nextAction = TICKET_NEXT.CANCELLED;
        ticket.revision += 1;
        ctrl.db.putTicket(ticket);
      }
    }
    for (const budget of ctrl.db.listBudgets(waveId)) {
      if (budget.state === "RESERVED") {
        ctrl.db.putBudget(markIndeterminate(budget, now));
      }
    }
    refreshCounters(ctrl, waveId);
  });
  const wave = requireWave(ctrl, waveId);
  if (wave.flowId) {
    void ctrl.workflow.cancelWave(wave.flowId);
  }
  return inspect(ctrl, waveId);
}

export function approveWave(
  ctrl: ControllerContext,
  waveId: string,
  ticketId: string,
  expectedTicketRevision: number,
  eventId: string,
): WaveView {
  recordOrThrow(ctrl, eventId, waveId, "approve", { ticketId, expectedTicketRevision });
  ctrl.db.transaction(() => {
    const wave = requireWave(ctrl, waveId);
    if (wave.cancelRequested) throw new WaveError("Wave is cancelled.", "cancelled");
    const ticket = requireTicket(ctrl, waveId, ticketId);
    assertExpectedRevision(ticket.revision, expectedTicketRevision);
    assertTicketTransition(ticket.status, "APPROVED", wave.cancelRequested);
    ticket.status = "APPROVED";
    ticket.owner = TICKET_OWNERS.APPROVED;
    ticket.nextAction = TICKET_NEXT.APPROVED;
    ticket.revision += 1;
    ctrl.db.putTicket(ticket);
    if (wave.status === "WAITING_APPROVAL" || wave.status === "AWAITING_PLAN_GATE") {
      assertWaveTransition(wave.status, "RUNNING", wave.cancelRequested);
      wave.status = "RUNNING";
      wave.owner = WAVE_OWNERS.RUNNING;
      wave.nextAction = WAVE_NEXT.RUNNING;
      wave.revision += 1;
      wave.updatedAt = ctrl.clock.now();
      ctrl.db.putWave(wave);
    }
  });
  return inspect(ctrl, waveId);
}

export function reviseWave(
  ctrl: ControllerContext,
  waveId: string,
  ticketId: string,
  eventId: string,
): WaveView {
  recordOrThrow(ctrl, eventId, waveId, "revise", { ticketId });
  ctrl.db.transaction(() => {
    const wave = requireWave(ctrl, waveId);
    const ticket = requireTicket(ctrl, waveId, ticketId);
    assertTicketTransition(ticket.status, "REVISING", wave.cancelRequested);
    ticket.status = "REVISING";
    ticket.owner = TICKET_OWNERS.REVISING;
    ticket.nextAction = TICKET_NEXT.REVISING;
    ticket.revision += 1;
    ctrl.db.putTicket(ticket);
    if (wave.status === "WAITING_APPROVAL" || wave.status === "AWAITING_PLAN_GATE") {
      assertWaveTransition(wave.status, "RUNNING", wave.cancelRequested);
      wave.status = "RUNNING";
      wave.owner = WAVE_OWNERS.RUNNING;
      wave.nextAction = WAVE_NEXT.RUNNING;
      wave.revision += 1;
      wave.updatedAt = ctrl.clock.now();
      ctrl.db.putWave(wave);
    }
  });
  return inspect(ctrl, waveId);
}

export function emergencyStop(ctrl: ControllerContext, reason = "operator emergency stop"): { stopped: string[] } {
  const stopped: string[] = [];
  for (const wave of ctrl.db.listWaves()) {
    if (isTerminalWave(wave.status)) continue;
    cancelWave(ctrl, wave.waveId, nextEventId());
    stopForBudget(ctrl, wave.waveId, reason);
    stopped.push(wave.waveId);
  }
  return { stopped };
}

export function backupWave(ctrl: ControllerContext, destPath: string): { path: string; schemaVersion: number } {
  mkdirSync(dirname(destPath), { recursive: true });
  if (ctrl.db.path === ":memory:") {
    throw new WaveError("Cannot backup an in-memory database; use a file-backed store.", "backup");
  }
  ctrl.db.db.exec("PRAGMA wal_checkpoint(FULL);");
  copyFileSync(ctrl.db.path, destPath);
  return { path: destPath, schemaVersion: ctrl.db.schemaVersion() };
}
