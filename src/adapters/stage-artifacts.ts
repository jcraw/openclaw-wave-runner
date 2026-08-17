import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { LaunchReceipt, StageName, WorkerTruth } from "../domain/types.js";
export type { StageAttemptRef } from "../core/stage-paths.js";
export { stageAttemptDir, stageSessionKey } from "../core/stage-paths.js";

export type StageTerminal = {
  idempotencyKey: string;
  waveId: string;
  ticketId: string;
  stage: StageName;
  attempt: number;
  status: "succeeded" | "failed" | "cancelled";
  artifact?: string;
  hash?: string;
};

export function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Strip optional `sha256:` prefix (case-insensitive) before compare. */
export function normalizeArtifactHash(hash: string): string {
  return hash.replace(/^sha256:/i, "").trim().toLowerCase();
}

export function ensureStageAttemptDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export function readJsonFile<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function readOptionalText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export function writeStageTerminal(dir: string, terminal: StageTerminal): string {
  ensureStageAttemptDir(dir);
  const path = join(dir, "terminal.json");
  writeJsonAtomic(path, terminal);
  return path;
}

export function readStageTerminal(dir: string): StageTerminal | undefined {
  return readJsonFile<StageTerminal>(join(dir, "terminal.json"));
}

export function terminalMatches(
  terminal: StageTerminal,
  expected: {
    idempotencyKey: string;
    waveId: string;
    ticketId: string;
    stage: StageName;
    attempt: number;
  },
): boolean {
  return (
    terminal.idempotencyKey === expected.idempotencyKey &&
    terminal.waveId === expected.waveId &&
    terminal.ticketId === expected.ticketId &&
    terminal.stage === expected.stage &&
    terminal.attempt === expected.attempt
  );
}

export function requiredStageArtifact(stage: StageName): string {
  if (stage === "PLAN") return "PLAN.md";
  if (stage === "IMPL") return "IMPL_DONE.json";
  return "VERIFY.json";
}

export function inspectStageArtifacts(input: {
  stage: StageName;
  outputDir: string;
  idempotencyKey: string;
  waveId: string;
  ticketId: string;
  attempt: number;
  live?: boolean;
}): WorkerTruth {
  if (input.live) {
    return { status: "running", outputRef: input.outputDir };
  }
  const terminal = readStageTerminal(input.outputDir);
  if (!terminal || !terminalMatches(terminal, input)) {
    return {
      status: "unknown",
      error: "missing or mismatched stage terminal attestation",
      outputRef: input.outputDir,
    };
  }
  if (terminal.status === "failed") {
    return { status: "failed", error: "stage terminal marked failed", outputRef: join(input.outputDir, "terminal.json") };
  }
  if (terminal.status === "cancelled") {
    return { status: "cancelled", outputRef: join(input.outputDir, "terminal.json") };
  }
  const artifactName = requiredStageArtifact(input.stage);
  const artifactPath = join(input.outputDir, artifactName);
  // Hash the on-disk bytes/text as written. Do not trim before hashing — workers
  // (and sha256sum) hash the full file, including a trailing newline.
  const text = readOptionalText(artifactPath);
  if (!text?.trim()) {
    return {
      status: "unknown",
      error: `stage ${input.stage} terminal is present but ${artifactName} is missing`,
      outputRef: input.outputDir,
    };
  }
  if (terminal.hash && normalizeArtifactHash(terminal.hash) !== sha256Text(text)) {
    return {
      status: "unknown",
      error: "stage terminal hash does not match artifact",
      outputRef: artifactPath,
    };
  }
  return {
    status: "succeeded",
    summary: text.trim(),
    outputRef: artifactPath,
  };
}

export function inspectReceiptArtifacts(receipt: LaunchReceipt): WorkerTruth | undefined {
  if (!receipt.outputDir) return undefined;
  const sourceId = receipt.idempotencyKey;
  const parts = sourceId.split(":");
  const attempt = Number(parts[3] ?? "1");
  return inspectStageArtifacts({
    stage: parts[2] === "IMPL" || parts[2] === "VERIFY" ? parts[2] : "PLAN",
    outputDir: receipt.outputDir,
    idempotencyKey: sourceId,
    waveId: parts[0] ?? "",
    ticketId: parts[1] ?? "",
    attempt: Number.isInteger(attempt) ? attempt : 1,
    live: false,
  });
}
