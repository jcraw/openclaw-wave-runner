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
