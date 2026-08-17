import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_VERIFY_TIMEOUT_MS = 300_000;

export type VerifyClassify = "runner_verify" | "product_verify";

export type VerifyRecord = {
  ok: boolean;
  command: string;
  stdout: string;
  stderr: string;
  output: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
};

export type VerifyExecResult = VerifyRecord & {
  proof: string;
  classify: VerifyClassify;
};

export function parseVerifyTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_VERIFY_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_VERIFY_TIMEOUT_MS;
  return n;
}

export function classifyVerifyFailure(input: {
  timedOut: boolean;
  code?: string | number;
  exitCode: number | null;
}): VerifyClassify {
  if (input.timedOut) return "runner_verify";
  if (typeof input.code === "string") {
    const code = input.code.toUpperCase();
    if (
      code === "ETIMEDOUT" ||
      code === "ENOENT" ||
      code === "EACCES" ||
      code === "EPERM" ||
      code.startsWith("ERR_")
    ) {
      return "runner_verify";
    }
  }
  if (input.exitCode !== null && input.exitCode !== 0) return "product_verify";
  return "runner_verify";
}

function asText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return String(value);
}

type ExecLike = {
  status?: number | null;
  signal?: NodeJS.Signals | string | null;
  stdout?: unknown;
  stderr?: unknown;
  code?: string | number;
  killed?: boolean;
};

export function runWorkspaceVerify(input: {
  worktree: string;
  command: string;
  timeoutMs?: number;
}): VerifyExecResult {
  const proof = join(input.worktree, "WAVE_VERIFY.json");
  const timeoutMs = input.timeoutMs ?? parseVerifyTimeoutMs(process.env.WAVE_VERIFY_TIMEOUT_MS);
  const started = Date.now();
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = 0;
  let signal: string | null = null;
  let timedOut = false;
  let ok = true;
  let code: string | number | undefined;
  try {
    stdout = execFileSync("bash", ["-lc", input.command], {
      cwd: input.worktree,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });
  } catch (error) {
    ok = false;
    if (error && typeof error === "object") {
      const err = error as ExecLike;
      stdout = asText(err.stdout);
      stderr = asText(err.stderr);
      exitCode = typeof err.status === "number" ? err.status : null;
      signal = err.signal ? String(err.signal) : null;
      code = err.code;
      timedOut = err.code === "ETIMEDOUT";
    } else {
      stderr = String(error);
      exitCode = null;
    }
  }
  const durationMs = Date.now() - started;
  const output = [stdout, stderr].filter(Boolean).join("\n");
  const classify = ok ? "product_verify" : classifyVerifyFailure({ timedOut, code, exitCode });
  const record: VerifyRecord = {
    ok,
    command: input.command,
    stdout,
    stderr,
    output,
    exitCode,
    signal,
    timedOut,
    durationMs,
  };
  writeFileSync(proof, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return { ...record, proof, classify };
}
