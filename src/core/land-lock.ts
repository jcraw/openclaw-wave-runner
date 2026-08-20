import { AdmissionDeniedError } from "../domain/errors.js";
import type { WaveRecord } from "../domain/types.js";
import { landLockKey } from "../domain/writer-scope.js";
import { claimantFields, type AuthorityAcquireInput } from "./authority.js";
import type { ControllerContext } from "./controller-context.js";
import { acquireLease, canAcquire, releaseLease } from "./lease.js";

export type LandLockAcquire =
  | { ok: true; generation: number }
  | { ok: false; deferred: true; reason: string };

function landInput(
  ctrl: ControllerContext,
  wave: WaveRecord,
  ticketId: string,
  now: number,
): AuthorityAcquireInput {
  return {
    repoPath: wave.repoPath,
    kind: "land",
    resourceKey: landLockKey(wave.repoPath),
    waveId: wave.waveId,
    ticketId,
    now,
    ttlMs: ctrl.leaseTtlMs,
    ...claimantFields(ctrl.process),
  };
}

/**
 * Single-attempt land lock. Same-operator same-ticket `hold` refreshes.
 * Foreign `deny` or a different ticket on this operator is deferred — not FAILED.
 * Shared sqlite is the authority; host file locks are a best-effort extra fence.
 */
export async function acquireExclusiveLandLock(
  ctrl: ControllerContext,
  wave: WaveRecord,
  ticketId: string,
): Promise<LandLockAcquire> {
  return ctrl.db.transaction(() => acquireLandLockSync(ctrl, wave, ticketId));
}

function acquireLandLockSync(
  ctrl: ControllerContext,
  wave: WaveRecord,
  ticketId: string,
): LandLockAcquire {
  const resourceKey = landLockKey(wave.repoPath);
  const now = ctrl.clock.now();
  const current = ctrl.db.getLease(resourceKey);
  const decision = canAcquire(current, now, ctrl.process);
  if (decision === "deny") {
    return {
      ok: false,
      deferred: true,
      reason: `land lock held by ${current?.holder ?? "unknown"}`,
    };
  }
  if (decision === "hold" && current?.ticketId && current.ticketId !== ticketId) {
    return {
      ok: false,
      deferred: true,
      reason: `land lock held by ${current.ticketId}`,
    };
  }
  try {
    const lock = acquireLease({
      current,
      resourceKey,
      now,
      ttlMs: ctrl.leaseTtlMs,
      claimant: ctrl.process,
      waveId: wave.waveId,
      ticketId,
    });
    ctrl.db.putLease(lock);
    try {
      ctrl.authority.tryAcquire(landInput(ctrl, wave, ticketId, now));
    } catch {
      /* sqlite is the land authority */
    }
    return { ok: true, generation: lock.generation };
  } catch (err) {
    if (err instanceof AdmissionDeniedError) {
      return { ok: false, deferred: true, reason: err.message };
    }
    throw err;
  }
}

export function releaseExclusiveLandLock(
  ctrl: ControllerContext,
  wave: WaveRecord,
  ticketId: string,
  generation: number,
): void {
  const resourceKey = landLockKey(wave.repoPath);
  try {
    ctrl.authority.release({
      repoPath: wave.repoPath,
      kind: "land",
      resourceKey,
      ticketId,
      waveId: wave.waveId,
    });
  } catch {
    /* best-effort */
  }
  const held = ctrl.db.getLease(resourceKey);
  if (!held || held.generation !== generation) return;
  try {
    releaseLease({
      current: held,
      claimant: ctrl.process,
      expectedGeneration: generation,
      now: ctrl.clock.now(),
    });
    ctrl.db.deleteLease(resourceKey);
  } catch {
    /* land lock must not leak a throw */
  }
}
