import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

import type {
  AuthorityAcquireInput,
  AuthorityAcquireResult,
  AuthorityHeld,
  AuthorityKind,
  AuthorityLockRecord,
  AuthorityPort,
  AuthorityRef,
} from "../core/authority.js";
import { pidAlive } from "../core/authority.js";
import { gitCommonDir } from "../core/repo-identity.js";
import { sanitizeWriterToken } from "../domain/writer-scope.js";

export { gitCommonDir } from "../core/repo-identity.js";

export function readPidStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
    return rest[19];
  } catch {
    return undefined;
  }
}

function lockDir(commonDir: string): string {
  return join(commonDir, "wave-runner", "locks");
}

function lockFileName(kind: AuthorityKind, scope?: string): string {
  if (kind === "land") return "land.lock";
  return `writer-${sanitizeWriterToken(scope ?? "default")}.lock`;
}

function lockPath(repoPath: string, kind: AuthorityKind, scope?: string): string | undefined {
  const common = gitCommonDir(repoPath);
  if (!common) return undefined;
  return join(lockDir(common), lockFileName(kind, scope));
}

function startTimeMismatch(rec: AuthorityLockRecord): boolean {
  if (typeof rec.pid !== "number" || !rec.pidStartTime) return false;
  const live = readPidStartTime(rec.pid);
  return Boolean(live && live !== rec.pidStartTime);
}

function deadOrReused(rec: AuthorityLockRecord): boolean {
  if (typeof rec.pid === "number" && !pidAlive(rec.pid)) return true;
  return startTimeMismatch(rec);
}

function parseLock(path: string): AuthorityLockRecord | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AuthorityLockRecord>;
    if (typeof raw.ticketId !== "string" || typeof raw.waveId !== "string") return undefined;
    if (typeof raw.resourceKey !== "string" || typeof raw.holder !== "string") return undefined;
    if (typeof raw.expiresAt !== "number" || typeof raw.generation !== "number") return undefined;
    const rec: AuthorityLockRecord = {
      waveId: raw.waveId,
      ticketId: raw.ticketId,
      resourceKey: raw.resourceKey,
      expiresAt: raw.expiresAt,
      holder: raw.holder,
      generation: raw.generation,
    };
    if (typeof raw.pid === "number") rec.pid = raw.pid;
    if (typeof raw.pidStartTime === "string") rec.pidStartTime = raw.pidStartTime;
    return rec;
  } catch {
    return undefined;
  }
}

function writeLockAtomic(dest: string, rec: AuthorityLockRecord): boolean {
  const dir = dirname(dest);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${randomBytes(8).toString("hex")}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(rec)}\n`, "utf8");
  try {
    linkSync(tmp, dest);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") throw error;
    return false;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* tmp */
    }
  }
}

export class GitRepoAuthority implements AuthorityPort {
  tryAcquire(input: AuthorityAcquireInput): AuthorityAcquireResult {
    const dest = lockPath(input.repoPath, input.kind, input.scope);
    if (!dest) return { ok: false, reason: "git-common-dir missing" };
    const pid = input.pid ?? process.pid;
    const pidStartTime = input.pidStartTime ?? readPidStartTime(pid);
    const rec: AuthorityLockRecord = {
      pid,
      waveId: input.waveId,
      ticketId: input.ticketId,
      resourceKey: input.resourceKey,
      expiresAt: input.now + input.ttlMs,
      holder: input.holder,
      generation: 1,
    };
    if (pidStartTime) rec.pidStartTime = pidStartTime;
    if (existsSync(dest)) {
      const cur = parseLock(dest);
      if (cur && !deadOrReused(cur) && cur.expiresAt > input.now) {
        if (cur.ticketId === input.ticketId && cur.waveId === input.waveId) {
          writeFileSync(dest, `${JSON.stringify({ ...cur, ...rec, generation: cur.generation })}\n`, "utf8");
          return { ok: true, generation: cur.generation };
        }
        return { ok: false, reason: `held by ${cur.ticketId}` };
      }
      rec.generation = (cur?.generation ?? 0) + 1;
      try {
        unlinkSync(dest);
      } catch {
        return { ok: false, reason: `held by ${cur?.ticketId ?? "unknown"}` };
      }
    }
    if (!writeLockAtomic(dest, rec)) return { ok: false, reason: "held by concurrent acquirer" };
    return { ok: true, generation: rec.generation };
  }

  release(input: AuthorityRef & { ticketId: string; waveId: string }): void {
    const dest = lockPath(input.repoPath, input.kind, input.scope);
    if (!dest || !existsSync(dest)) return;
    const cur = parseLock(dest);
    if (cur && (cur.ticketId !== input.ticketId || cur.waveId !== input.waveId)) return;
    try {
      unlinkSync(dest);
    } catch {
      /* best-effort */
    }
  }

  heldBy(input: AuthorityRef & { now: number }): AuthorityHeld | undefined {
    const dest = lockPath(input.repoPath, input.kind, input.scope);
    if (!dest || !existsSync(dest)) return undefined;
    const cur = parseLock(dest);
    if (!cur || deadOrReused(cur)) return undefined;
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
