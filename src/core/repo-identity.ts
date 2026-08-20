import { existsSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { sha256 } from "../domain/hash.js";
import { SafetyGateError } from "../domain/errors.js";
import { normalizeRepoPath } from "../domain/writer-scope.js";

/** Same disk UUID as `scripts/run-backlog-wave.sh`. Supervised WAVE_DB must stay here. */
export const WR_SCRATCH_EXPECTED_UUID = "866e11e8-6c31-4c0c-a07c-704845033900";

function gitRevParse(repoPath: string, flag: "--git-common-dir" | "--show-toplevel"): string | undefined {
  try {
    const out = execFileSync("git", ["-C", repoPath, "rev-parse", flag], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (!out) return undefined;
    if (flag === "--show-toplevel") return out;
    return out.startsWith("/") ? out : join(repoPath, out);
  } catch {
    return undefined;
  }
}

export function gitCommonDir(repoPath: string): string | undefined {
  return gitRevParse(repoPath, "--git-common-dir");
}

function gitToplevel(repoPath: string): string | undefined {
  return gitRevParse(repoPath, "--show-toplevel");
}

function realExisting(path: string): string {
  try {
    return existsSync(path) ? realpathSync(path) : path;
  } catch {
    return path;
  }
}

/**
 * One identity for shared-ledger paths, lease keys, and stored `wave.repoPath`.
 * Working-tree realpath (symlink + trailing slash collapse). Git common-dir is
 * hashed too so two spellings of the same checkout share a ledger.
 */
export function canonicalRepoIdentity(repoPath: string): string {
  const trimmed = normalizeRepoPath(repoPath);
  const resolved = realExisting(trimmed);
  const top = gitToplevel(resolved) ?? gitToplevel(trimmed);
  if (top) return realExisting(top);
  const common = gitCommonDir(resolved) ?? gitCommonDir(trimmed);
  if (common) return realExisting(common);
  return resolved;
}

export function sharedLedgerPath(scratchDir: string, identity: string): string {
  const scratch = normalizeRepoPath(scratchDir);
  return join(scratch, "ledgers", `${sha256(identity)}.sqlite`);
}

export function scratchFilesystemUuid(scratchDir: string): string | undefined {
  try {
    const out = execFileSync("findmnt", ["-n", "-o", "UUID", "-T", scratchDir], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

export function resolveSupervisedWaveDb(input: {
  repoPath: string;
  scratchDir?: string;
  explicitDb?: string;
  env?: NodeJS.ProcessEnv;
  requireScratchUuid?: boolean;
}): { dbPath: string; identity: string; scratch?: string } {
  const env = input.env ?? process.env;
  const identity = canonicalRepoIdentity(input.repoPath);
  const explicit = input.explicitDb?.trim() || env.WAVE_DB?.trim();
  if (explicit) return { dbPath: explicit, identity };
  const scratch = input.scratchDir?.trim() || env.WR_SCRATCH?.trim();
  if (!scratch) {
    throw new SafetyGateError("supervised WAVE_DB requires WR_SCRATCH or an explicit WAVE_DB / --db.");
  }
  if (input.requireScratchUuid === true && scratchFilesystemUuid(scratch) !== WR_SCRATCH_EXPECTED_UUID) {
    throw new SafetyGateError(
      `Wave Runner scratch is not on the 7.3T data disk (unmounted or wrong UUID): ${scratch}`,
    );
  }
  return { dbPath: sharedLedgerPath(scratch, identity), identity, scratch };
}

const OPERATOR_ID_RE = /^[A-Za-z0-9._:-]+$/;

export function assertSafeOperatorId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 160 || !OPERATOR_ID_RE.test(trimmed)) {
    throw new SafetyGateError("WAVE_RUNNER_OPERATOR_ID is empty or unsafe.");
  }
  return trimmed;
}

export function operatorIdentityFromWaveId(waveId: string): string {
  const id = waveId.trim();
  if (!id || id.length > 128 || !OPERATOR_ID_RE.test(id)) {
    throw new SafetyGateError("supervised CLI requires a safe wave id for operator identity.");
  }
  return `cli-wave:${id}`;
}

export function resolveCliOperatorIdentity(input: {
  supervised: boolean;
  waveId?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  if (!input.supervised) return "cli-operator";
  const env = input.env ?? process.env;
  const fromEnv = env.WAVE_RUNNER_OPERATOR_ID?.trim();
  if (fromEnv) return assertSafeOperatorId(fromEnv);
  if (input.waveId?.trim()) return operatorIdentityFromWaveId(input.waveId);
  throw new SafetyGateError("supervised CLI requires WAVE_RUNNER_OPERATOR_ID or --wave.");
}

/** Collision-resistant wrapper id (timestamp + uuid). Bash uses the same idea. */
export function newWaveId(prefix: string): string {
  const safe = prefix.replace(/[^A-Za-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "") || "W";
  return `${safe}-${Date.now()}-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
}
