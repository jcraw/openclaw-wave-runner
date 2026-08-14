import { AdmissionDeniedError, WaveError } from "../domain/errors.js";
import type { LeaseRecord } from "../domain/types.js";

export type ProcessIdentity = {
  holder: string;
  processIdentity: string;
  pid?: number;
  pidStartTime?: string;
};

export function canAcquire(
  current: LeaseRecord | undefined,
  now: number,
  claimant: ProcessIdentity,
): "acquire" | "hold" | "deny" {
  if (!current) return "acquire";
  if (current.holder === claimant.holder && current.processIdentity === claimant.processIdentity) {
    return "hold";
  }
  if (current.expiresAt <= now) return "acquire";
  return "deny";
}

export function acquireLease(input: {
  current?: LeaseRecord;
  resourceKey: string;
  now: number;
  ttlMs: number;
  claimant: ProcessIdentity;
  waveId?: string;
  ticketId?: string;
  taskId?: string;
}): LeaseRecord {
  const decision = canAcquire(input.current, input.now, input.claimant);
  if (decision === "deny") {
    throw new AdmissionDeniedError(`lease ${input.resourceKey} is held by ${input.current?.holder}.`);
  }
  const generation = decision === "hold" ? input.current!.generation : (input.current?.generation ?? 0) + 1;
  return {
    resourceKey: input.resourceKey,
    generation,
    holder: input.claimant.holder,
    processIdentity: input.claimant.processIdentity,
    pid: input.claimant.pid,
    pidStartTime: input.claimant.pidStartTime,
    expiresAt: input.now + input.ttlMs,
    createdAt: input.current?.createdAt ?? input.now,
    waveId: input.waveId,
    ticketId: input.ticketId,
    taskId: input.taskId,
  };
}

/**
 * PID reuse cannot release a lease: expiry + fencing generation + process
 * identity (pid + start time) must all match. A later process with the same
 * pid but a different start time is treated as a stranger.
 */
export function releaseLease(input: {
  current: LeaseRecord;
  claimant: ProcessIdentity;
  expectedGeneration: number;
  now: number;
}): void {
  if (input.current.generation !== input.expectedGeneration) {
    throw new WaveError(
      `Stale lease generation ${input.expectedGeneration}; current is ${input.current.generation}.`,
      "stale_lease",
    );
  }
  if (input.current.holder !== input.claimant.holder) {
    throw new WaveError("Lease holder mismatch.", "lease_holder");
  }
  if (input.current.processIdentity !== input.claimant.processIdentity) {
    throw new WaveError("Process identity mismatch; PID reuse cannot release this lease.", "lease_pid_reuse");
  }
  if (
    input.current.pid !== undefined &&
    input.claimant.pid !== undefined &&
    input.current.pid === input.claimant.pid &&
    input.current.pidStartTime &&
    input.claimant.pidStartTime &&
    input.current.pidStartTime !== input.claimant.pidStartTime
  ) {
    throw new WaveError("PID start-time mismatch; treating as PID reuse.", "lease_pid_reuse");
  }
}

export function isLeaseStale(lease: LeaseRecord, now: number): boolean {
  return lease.expiresAt <= now;
}
