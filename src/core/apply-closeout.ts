import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { closeoutModeForWaveTicket } from "../domain/closeout-mode.js";
import { hashJson } from "../domain/hash.js";
import type { LaunchOutbox, TicketRun, WaveRecord } from "../domain/types.js";
import type { ControllerContext } from "./controller-context.js";
import { refreshCounters, requireTicket, requireWave } from "./controller-context.js";
import { acquireExclusiveLandLock, releaseExclusiveLandLock } from "./land-lock.js";
import { clipReason } from "./land-recovery.js";
import type { ApplyResult } from "./ports.js";
import { TICKET_NEXT, TICKET_OWNERS } from "./state-machine.js";

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

function failApply(ctrl: ControllerContext, waveId: string, ticketId: string, reason: string): void {
  ctrl.db.transaction(() => {
    const ticket = requireTicket(ctrl, waveId, ticketId);
    putTicketStatus(ctrl, ticket, "FAILED", clipReason(reason));
    refreshCounters(ctrl, waveId);
  });
}

function recordProof(
  ctrl: ControllerContext,
  waveId: string,
  ticketId: string,
  path: string,
): void {
  ctrl.db.putArtifact({
    artifactId: `${waveId}:art:${randomUUID()}`,
    waveId,
    ticketId,
    kind: "proof",
    path,
    hash: hashJson(path),
    createdAt: ctrl.clock.now(),
  });
}

export async function executeApplyCloseout(
  ctrl: ControllerContext,
  item: LaunchOutbox,
  wave: WaveRecord,
  ticket: TicketRun,
  opts: { doneOnOk: boolean },
): Promise<void> {
  if (!ticket.implWorktree) {
    failApply(ctrl, item.waveId, item.ticketId, "apply failed: missing impl worktree");
    return;
  }
  if (!ctrl.workspace.applyToWorkdir) {
    failApply(ctrl, item.waveId, item.ticketId, "apply failed: applyToWorkdir missing");
    return;
  }
  const applied: ApplyResult = await ctrl.workspace.applyToWorkdir({
    repoPath: wave.repoPath,
    worktree: ticket.implWorktree,
    ticketId: ticket.ticketId,
    waveId: item.waveId,
    baseSha: wave.baseSha,
    ...(ctrl.artifactRoot ? { artifactRoot: ctrl.artifactRoot } : {}),
  });
  ctrl.db.transaction(() => {
    const live = requireTicket(ctrl, item.waveId, item.ticketId);
    if (applied.ok && applied.proof && existsSync(applied.proof)) {
      if (opts.doneOnOk) {
        putTicketStatus(ctrl, live, "DONE", "verified+applied");
      } else {
        putTicketStatus(ctrl, live, "FAILED", clipReason(`${live.result ?? "failed"} + applied`));
      }
      recordProof(ctrl, item.waveId, item.ticketId, applied.proof);
    } else if (applied.ok) {
      putTicketStatus(ctrl, live, "FAILED", clipReason("apply failed: missing APPLY.json"));
    } else {
      const conflict = applied.error ?? "APPLY_CONFLICT";
      const labeled = conflict.startsWith("APPLY_CONFLICT") ? conflict : `APPLY_CONFLICT: ${conflict}`;
      if (opts.doneOnOk) {
        putTicketStatus(ctrl, live, "FAILED", clipReason(labeled));
      } else {
        putTicketStatus(ctrl, live, "FAILED", clipReason(`${live.result ?? "failed"} + ${conflict}`));
      }
      if (applied.proof) recordProof(ctrl, item.waveId, item.ticketId, applied.proof);
    }
    refreshCounters(ctrl, item.waveId);
  });
}

/** Apply-mode: copy the impl worktree into primary after retries are exhausted. Never DONE. */
export async function applyOnExhaustedImpl(ctrl: ControllerContext, item: LaunchOutbox): Promise<void> {
  const wave = requireWave(ctrl, item.waveId);
  const ticket = requireTicket(ctrl, item.waveId, item.ticketId);
  if (ticket.status !== "FAILED" || !ticket.implWorktree) return;
  if (closeoutModeForWaveTicket(wave.manifestJson, ticket.ticketId) !== "apply") return;
  const got = await acquireExclusiveLandLock(ctrl, wave, item.ticketId);
  if (!got.ok) return;
  try {
    const live = requireTicket(ctrl, item.waveId, item.ticketId);
    if (live.status !== "FAILED" || !live.implWorktree) return;
    await executeApplyCloseout(ctrl, item, wave, live, { doneOnOk: false });
  } finally {
    releaseExclusiveLandLock(ctrl, wave, item.ticketId, got.generation);
  }
}
