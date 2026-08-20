import type { ProcessIdentity } from "./lease.js";

export type AuthorityKind = "writer" | "land";

export type AuthorityAcquireInput = {
  repoPath: string;
  kind: AuthorityKind;
  scope?: string;
  resourceKey: string;
  waveId: string;
  ticketId: string;
  holder: string;
  pid?: number;
  pidStartTime?: string;
  now: number;
  ttlMs: number;
};

export type AuthorityAcquireResult =
  | { ok: true; generation: number }
  | { ok: false; reason: string };

export type AuthorityHeld = {
  ticketId: string;
  waveId: string;
  holder: string;
  expiresAt: number;
  pid?: number;
  pidStartTime?: string;
  generation: number;
};

export type AuthorityRef = {
  repoPath: string;
  kind: AuthorityKind;
  scope?: string;
  resourceKey: string;
};

export interface AuthorityPort {
  tryAcquire(input: AuthorityAcquireInput): AuthorityAcquireResult;
  release(input: AuthorityRef & { ticketId: string; waveId: string }): void;
  heldBy(input: AuthorityRef & { now: number }): AuthorityHeld | undefined;
}

export type AuthorityLockRecord = {
  pid?: number;
  pidStartTime?: string;
  waveId: string;
  ticketId: string;
  resourceKey: string;
  expiresAt: number;
  holder: string;
  generation: number;
};

export const LAND_LOCK_POLL_MS = 50;

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function pidAlive(pid?: number): boolean {
  if (typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function deadHolder(rec: AuthorityLockRecord): boolean {
  if (typeof rec.pid !== "number") return false;
  return !pidAlive(rec.pid);
}

export function claimantFields(process: ProcessIdentity): Pick<
  AuthorityAcquireInput,
  "holder" | "pid" | "pidStartTime"
> {
  return {
    holder: process.holder,
    ...(process.pid !== undefined ? { pid: process.pid } : {}),
    ...(process.pidStartTime !== undefined ? { pidStartTime: process.pidStartTime } : {}),
  };
}

/**
 * In-memory map for tests/simulators. Supervised CLI waves share one SQLite
 * ledger per canonical repo (`WR_SCRATCH/ledgers/`). Host-local file locks
 * in adapters/repo-authority.ts are leftover pairing, not the cross-wave
 * authority.
 */
export class MemoryAuthority implements AuthorityPort {
  private readonly locks = new Map<string, AuthorityLockRecord>();

  tryAcquire(input: AuthorityAcquireInput): AuthorityAcquireResult {
    const cur = this.locks.get(input.resourceKey);
    if (cur && !deadHolder(cur) && cur.expiresAt > input.now) {
      if (cur.ticketId === input.ticketId && cur.waveId === input.waveId) {
        const next = { ...cur, expiresAt: input.now + input.ttlMs, holder: input.holder };
        if (input.pid !== undefined) next.pid = input.pid;
        if (input.pidStartTime !== undefined) next.pidStartTime = input.pidStartTime;
        this.locks.set(input.resourceKey, next);
        return { ok: true, generation: cur.generation };
      }
      return { ok: false, reason: `held by ${cur.ticketId}` };
    }
    const generation = (cur?.generation ?? 0) + 1;
    const rec: AuthorityLockRecord = {
      waveId: input.waveId,
      ticketId: input.ticketId,
      resourceKey: input.resourceKey,
      expiresAt: input.now + input.ttlMs,
      holder: input.holder,
      generation,
    };
    if (input.pid !== undefined) rec.pid = input.pid;
    if (input.pidStartTime !== undefined) rec.pidStartTime = input.pidStartTime;
    this.locks.set(input.resourceKey, rec);
    return { ok: true, generation };
  }

  release(input: AuthorityRef & { ticketId: string; waveId: string }): void {
    const cur = this.locks.get(input.resourceKey);
    if (!cur) return;
    if (cur.ticketId !== input.ticketId || cur.waveId !== input.waveId) return;
    this.locks.delete(input.resourceKey);
  }

  heldBy(input: AuthorityRef & { now: number }): AuthorityHeld | undefined {
    const cur = this.locks.get(input.resourceKey);
    if (!cur || deadHolder(cur)) return undefined;
    return {
      ticketId: cur.ticketId,
      waveId: cur.waveId,
      holder: cur.holder,
      expiresAt: cur.expiresAt,
      generation: cur.generation,
      ...(cur.pid !== undefined ? { pid: cur.pid } : {}),
      ...(cur.pidStartTime !== undefined ? { pidStartTime: cur.pidStartTime } : {}),
    };
  }
}
