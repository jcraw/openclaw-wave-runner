import type { LaunchReceipt, StageName } from "../domain/types.js";
import type { ControllerContext } from "./controller-context.js";
import { settleOutbox } from "./settlement.js";

export const DEFAULT_PLAN_WALL_MS = 45 * 60 * 1000;
export const DEFAULT_IMPL_WALL_MS = 90 * 60 * 1000;

export function parseWallMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

export function stageWallMs(stage: StageName, env: NodeJS.Dict<string> = process.env): number {
  if (stage === "PLAN") return parseWallMs(env.WAVE_PLAN_WALL_MS, DEFAULT_PLAN_WALL_MS);
  return parseWallMs(env.WAVE_IMPL_WALL_MS, DEFAULT_IMPL_WALL_MS);
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
    const receipt = receiptOf(item);
    try {
      await ctrl.worker.cancel(receipt);
    } catch {
      // Cancel is best-effort; settle still fail-closes the hung stage.
    }
    await settleOutbox(
      ctrl,
      item,
      receipt,
      "failed",
      receipt.outputDir,
      undefined,
      `stage_watchdog: ${item.stage} hung`,
    );
  }
}
