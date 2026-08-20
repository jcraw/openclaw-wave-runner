import type { WaveRecord } from "../domain/types.js";
import { landLockKey } from "../domain/writer-scope.js";
import {
  LAND_LOCK_POLL_MS,
  claimantFields,
  pidAlive,
  type AuthorityAcquireInput,
} from "./authority.js";
import type { ControllerContext } from "./controller-context.js";
import { acquireLease, releaseLease } from "./lease.js";

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
 * Wait until land sqlite + authority are free. Never steal via same-process "hold".
 * Live holder past expiresAt → land lock timeout (keep land-retry). Dead pid is harvested.
 */
export async function acquireExclusiveLandLock(
  ctrl: ControllerContext,
  wave: WaveRecord,
  ticketId: string,
): Promise<{ ok: true; generation: number } | { ok: false; reason: string }> {
  const resourceKey = landLockKey(wave.repoPath);
  for (;;) {
    const now = ctrl.clock.now();
    const current = ctrl.db.getLease(resourceKey);
    const held = ctrl.authority.heldBy({
      repoPath: wave.repoPath,
      kind: "land",
      resourceKey,
      now,
    });
    if (held && held.ticketId !== ticketId) {
      if (held.expiresAt > now) {
        await ctrl.sleep(LAND_LOCK_POLL_MS);
        continue;
      }
      if (pidAlive(held.pid)) return { ok: false, reason: "land lock timeout" };
    }
    if (current && current.ticketId !== ticketId && current.expiresAt > now) {
      await ctrl.sleep(LAND_LOCK_POLL_MS);
      continue;
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
      const auth = ctrl.authority.tryAcquire(landInput(ctrl, wave, ticketId, now));
      if (!auth.ok) {
        if (auth.reason.includes("git-common-dir")) return { ok: false, reason: auth.reason };
        await ctrl.sleep(LAND_LOCK_POLL_MS);
        continue;
      }
      ctrl.db.putLease(lock);
      return { ok: true, generation: lock.generation };
    } catch {
      await ctrl.sleep(LAND_LOCK_POLL_MS);
    }
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
