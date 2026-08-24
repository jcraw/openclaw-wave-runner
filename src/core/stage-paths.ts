import { join } from "node:path";

import type { StageName } from "../domain/types.js";

export type StageAttemptRef = {
  root: string;
  waveId: string;
  ticketId: string;
  stage: StageName;
  attempt: number;
};

export function stageAttemptDir(input: StageAttemptRef): string {
  return join(input.root, "tmp", "wave-runs", input.waveId, input.ticketId, input.stage, String(input.attempt));
}

export function stageSessionKey(input: {
  waveId: string;
  ticketId: string;
  stage: StageName;
  attempt: number;
}): string {
  return `agent:main:acp:wave-runner-${input.waveId}-${input.ticketId}-${input.stage}-${input.attempt}`;
}

/** Idempotency key `waveId:ticketId:STAGE:attempt`. Unknown STAGE → PLAN. */
export function parseStageFromIdempotencyKey(key: string): {
  waveId: string;
  ticketId: string;
  stage: StageName;
  attempt: number;
} {
  const parts = key.split(":");
  const raw = parts[2];
  const stage: StageName =
    raw === "IMPL" || raw === "VERIFY" || raw === "REVIEW" ? raw : "PLAN";
  const attempt = Number(parts[3] ?? "1");
  return {
    waveId: parts[0] ?? "",
    ticketId: parts[1] ?? key,
    stage,
    attempt: Number.isInteger(attempt) && attempt > 0 ? attempt : 1,
  };
}
