import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { hashJson } from "../domain/hash.js";
import type { LaunchOutbox, TicketRun, WaveRecord } from "../domain/types.js";
import { deriveWriterScope, landLockKey, writerLeaseKey } from "../domain/writer-scope.js";
import type { ControllerContext } from "./controller-context.js";
import { refreshCounters, requireTicket, requireWave } from "./controller-context.js";
import { closeoutDebtReason } from "./land-recovery.js";
import { acquireLease, canAcquire, releaseLease } from "./lease.js";
import type { LandResult } from "./ports.js";
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

/** Explicit operator env only. Never infer push from repo path. */
export function shouldLandPush(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WAVE_LAND_PUSH === "1";
}

/** IMPL settle/land requires a live matching writer lease when one exists — and refuses a missing lease (expired). */
export function implFenceFailure(
  ctrl: ControllerContext,
  item: LaunchOutbox,
  ticket: TicketRun,
  wave: WaveRecord,
): string | undefined {
  if (item.stage !== "IMPL") return undefined;
  const scope = ticket.writerScope || deriveWriterScope(ticket);
  const lease = ctrl.db.getLease(writerLeaseKey(wave.repoPath, scope));
  if (!lease) return "stale_fence: writer lease missing";
  if (lease.generation !== item.fencingGeneration) {
    return `stale_fence: generation ${item.fencingGeneration} != ${lease.generation}`;
  }
  if (lease.ticketId && lease.ticketId !== ticket.ticketId) {
    return `stale_fence: lease held by ${lease.ticketId}`;
  }
  return undefined;
}

function failLand(ctrl: ControllerContext, waveId: string, ticketId: string, reason: string): void {
  ctrl.db.transaction(() => {
    const ticket = requireTicket(ctrl, waveId, ticketId);
    putTicketStatus(ctrl, ticket, "FAILED", closeoutDebtReason(reason));
    refreshCounters(ctrl, waveId);
  });
}

export function releaseWriterLeaseAfterLand(ctrl: ControllerContext, item: LaunchOutbox): void {
  const ticket = requireTicket(ctrl, item.waveId, item.ticketId);
  const wave = requireWave(ctrl, item.waveId);
  const scope = ticket.writerScope || deriveWriterScope(ticket);
  const lease = ctrl.db.getLease(writerLeaseKey(wave.repoPath, scope));
  if (!lease || lease.ticketId !== ticket.ticketId) return;
  try {
    releaseLease({
      current: lease,
      claimant: ctrl.process,
      expectedGeneration: lease.generation,
      now: ctrl.clock.now(),
    });
    ctrl.db.deleteLease(lease.resourceKey);
  } catch {
    // writer release is best-effort after closeout
  }
}

export async function finalizeImplLand(
  ctrl: ControllerContext,
  item: LaunchOutbox,
): Promise<void> {
  const waveId = item.waveId;
  const wave = requireWave(ctrl, waveId);
  const lockKey = landLockKey(wave.repoPath);
  const now = ctrl.clock.now();
  const current = ctrl.db.getLease(lockKey);
  if (canAcquire(current, now, ctrl.process) !== "acquire") {
    failLand(ctrl, waveId, item.ticketId, "land lock held");
    releaseWriterLeaseAfterLand(ctrl, item);
    return;
  }
  const lock = acquireLease({
    current,
    resourceKey: lockKey,
    now,
    ttlMs: ctrl.leaseTtlMs,
    claimant: ctrl.process,
    waveId,
    ticketId: item.ticketId,
  });
  ctrl.db.putLease(lock);
  try {
    const ticket = requireTicket(ctrl, waveId, item.ticketId);
    if (!ticket.implWorktree) {
      failLand(ctrl, waveId, item.ticketId, "missing impl worktree");
      return;
    }
    if (!ctrl.workspace.landToMain) {
      failLand(ctrl, waveId, item.ticketId, "landToMain missing");
      return;
    }
    const land = await ctrl.workspace.landToMain({
      repoPath: wave.repoPath,
      worktree: ticket.implWorktree,
      branch: ticket.implBranch,
      ticketId: ticket.ticketId,
      waveId,
      baseSha: wave.baseSha,
      push: shouldLandPush(),
      ...(ctrl.artifactRoot ? { artifactRoot: ctrl.artifactRoot } : {}),
    });
    ctrl.db.transaction(() => {
      const live = requireTicket(ctrl, waveId, item.ticketId);
      if (land.ok && land.proof && existsSync(land.proof)) {
        putTicketStatus(
          ctrl,
          live,
          "DONE",
          land.commitSha ? `verified+landed ${land.commitSha.slice(0, 12)}` : "verified+landed",
        );
        ctrl.db.putArtifact({
          artifactId: `${waveId}:art:${randomUUID()}`,
          waveId,
          ticketId: item.ticketId,
          kind: "proof",
          path: land.proof,
          hash: hashJson(land.proof),
          createdAt: ctrl.clock.now(),
        });
      } else if (land.ok) {
        putTicketStatus(ctrl, live, "FAILED", closeoutDebtReason("missing LAND.json"));
      } else {
        putTicketStatus(ctrl, live, "FAILED", closeoutDebtReason(land.error ?? "unknown", land.proof));
        if (land.recovery) {
          ctrl.db.putArtifact({
            artifactId: `${waveId}:art:${randomUUID()}`,
            waveId,
            ticketId: item.ticketId,
            kind: "land-recovery",
            path: land.proof,
            hash: hashJson(land.recovery),
            createdAt: ctrl.clock.now(),
          });
        }
      }
      refreshCounters(ctrl, waveId);
    });
  } finally {
    const held = ctrl.db.getLease(lockKey);
    if (held && held.generation === lock.generation) {
      try {
        releaseLease({
          current: held,
          claimant: ctrl.process,
          expectedGeneration: held.generation,
          now: ctrl.clock.now(),
        });
        ctrl.db.deleteLease(lockKey);
      } catch {
        // land lock must not leak a throw after closeout
      }
    }
    releaseWriterLeaseAfterLand(ctrl, item);
  }
}

/** P1: re-run landToMain with no stash. Operator must clear overlap first. */
export async function retryImplLand(
  ctrl: ControllerContext,
  waveId: string,
  ticketId: string,
): Promise<LandResult> {
  const ticket = requireTicket(ctrl, waveId, ticketId);
  const missing: LandResult = {
    ok: false,
    proof: "",
    error: "land-retry refused: ticket not FAILED with impl worktree",
  };
  if (ticket.status !== "FAILED" || !ticket.implWorktree || !ctrl.workspace.landToMain) {
    return missing;
  }
  const item: LaunchOutbox = {
    outboxId: `${waveId}:obx:land-retry:${ticketId}`,
    waveId,
    ticketId,
    stage: "IMPL",
    attempt: 1,
    idempotencyKey: `${waveId}:${ticketId}:LAND_RETRY:1`,
    state: "SETTLED",
    fencingGeneration: 1,
    createdAt: ctrl.clock.now(),
    updatedAt: ctrl.clock.now(),
  };
  await finalizeImplLand(ctrl, item);
  const live = requireTicket(ctrl, waveId, ticketId);
  if (live.status === "DONE") {
    return { ok: true, proof: live.result ?? "", commitSha: live.result };
  }
  return { ok: false, proof: "", error: live.result ?? "land-retry failed" };
}
