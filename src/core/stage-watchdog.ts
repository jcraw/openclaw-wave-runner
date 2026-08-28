import type { LaunchOutbox, LaunchReceipt, StageName } from "../domain/types.js";
import type { ControllerContext } from "./controller-context.js";
import { isPlanGateStage } from "./stage-paths.js";
import { settleOutbox } from "./settlement.js";

export const DEFAULT_PLAN_WALL_MS = 45 * 60 * 1000;
export const DEFAULT_IMPL_WALL_MS = 90 * 60 * 1000;
export const DEFAULT_READ_FILE_HANG_MS = 60 * 1000;

export type GrokSessionEvent = {
  ts: string;
  type: string;
  tool_name?: string;
};

export function parseWallMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

export function stageWallMs(stage: StageName, env: NodeJS.Dict<string> = process.env): number {
  if (stage === "PLAN" || isPlanGateStage(stage)) return parseWallMs(env.WAVE_PLAN_WALL_MS, DEFAULT_PLAN_WALL_MS);
  return parseWallMs(env.WAVE_IMPL_WALL_MS, DEFAULT_IMPL_WALL_MS);
}

export function readFileHangMs(env: NodeJS.Dict<string> = process.env): number {
  return parseWallMs(env.WAVE_READ_FILE_HANG_MS, DEFAULT_READ_FILE_HANG_MS);
}

/** True when a read_file tool_started has no matching complete for hangMs. Other tools (verify bash) never trip this. */
export function readFileHungAt(
  events: GrokSessionEvent[],
  nowMs: number,
  hangMs: number,
): boolean {
  if (hangMs <= 0) return false;
  let inflight = 0;
  let lastStart = 0;
  for (const event of events) {
    if (event.type === "turn_ended") {
      inflight = 0;
      lastStart = 0;
      continue;
    }
    if (event.tool_name !== "read_file") continue;
    const ts = Date.parse(event.ts);
    if (!Number.isFinite(ts)) continue;
    if (event.type === "tool_started") {
      inflight += 1;
      lastStart = ts;
    } else if (event.type === "tool_completed") {
      inflight = Math.max(0, inflight - 1);
      if (inflight === 0) lastStart = 0;
    }
  }
  return inflight > 0 && lastStart > 0 && nowMs - lastStart >= hangMs;
}

const WEEK_S = 7 * 24 * 60 * 60;

/** Seconds to send on ACP spawn. Wall 0 (disabled watchdog) → 7d so ACP 3600s cannot win. */
export function acpTimeoutSeconds(stage: StageName, env: NodeJS.Dict<string> = process.env): number {
  const ms = stageWallMs(stage, env);
  if (ms === 0) return WEEK_S;
  return Math.max(1, Math.ceil(ms / 1000));
}

function receiptOf(item: { idempotencyKey: string; receiptJson?: string }): LaunchReceipt {
  if (!item.receiptJson) return { idempotencyKey: item.idempotencyKey };
  try {
    return JSON.parse(item.receiptJson) as LaunchReceipt;
  } catch {
    return { idempotencyKey: item.idempotencyKey };
  }
}

async function failHungOutbox(
  ctrl: ControllerContext,
  item: LaunchOutbox,
  reason: string,
): Promise<void> {
  const receipt = receiptOf(item);
  try {
    await ctrl.worker.cancel(receipt);
  } catch {
    // Cancel is best-effort; settle still fail-closes the hung stage.
  }
  await settleOutbox(ctrl, item, receipt, "failed", receipt.outputDir, undefined, reason);
}

/** After observeLaunched: cancel + fail-close LAUNCHED/RECONCILING past the stage wall. */
export async function applyStageWatchdog(ctrl: ControllerContext, waveId: string): Promise<void> {
  const now = ctrl.clock.now();
  const open = ctrl.db
    .listOutbox(waveId)
    .filter((item) => item.state === "LAUNCHED" || item.state === "RECONCILING");
  for (const item of open) {
    const wall = stageWallMs(item.stage);
    if (wall <= 0) continue;
    if (now - item.createdAt <= wall) continue;
    await failHungOutbox(ctrl, item, `stage_watchdog: ${item.stage} hung`);
  }
}

/** After observeLaunched: cancel if Grok session has a read_file started and not completed past hangMs. */
export async function applyReadFileWatchdog(ctrl: ControllerContext, waveId: string): Promise<void> {
  const hangMs = readFileHangMs();
  if (hangMs <= 0) return;
  const probe = ctrl.grokReadFileHung;
  if (!probe) return;
  const now = ctrl.clock.now();
  const open = ctrl.db
    .listOutbox(waveId)
    .filter((item) => item.state === "LAUNCHED" || item.state === "RECONCILING");
  for (const item of open) {
    const receipt = receiptOf(item);
    let hung = false;
    try {
      hung = probe(receipt, now, hangMs) === true;
    } catch {
      hung = false;
    }
    if (!hung) continue;
    await failHungOutbox(ctrl, item, "stage_watchdog: read_file hung");
  }
}
