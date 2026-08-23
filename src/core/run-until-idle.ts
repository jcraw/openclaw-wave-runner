import type { SupervisedStartOptions, WaveView } from "../domain/types.js";
import type { ControllerContext } from "./controller-context.js";
import { inspect } from "./controller-context.js";
import { needsPlanReviewLaunch } from "./plan-review-settle.js";
import { isTerminalWave } from "./state-machine.js";
import { tickWave } from "./tick.js";

export async function runUntilIdle(
  ctrl: ControllerContext,
  waveId: string,
  maxSteps = 32,
  options: SupervisedStartOptions = {},
): Promise<WaveView> {
  for (let i = 0; i < maxSteps; i += 1) {
    const before = inspect(ctrl, waveId);
    await tickWave(ctrl, waveId, options);
    const after = inspect(ctrl, waveId);
    const gated =
      after.wave.status === "AWAITING_PLAN_GATE" &&
      !after.outbox.some((item) => item.state !== "SETTLED" && item.state !== "FAILED") &&
      !needsPlanReviewLaunch(ctrl, waveId);
    if (
      isTerminalWave(after.wave.status) ||
      after.wave.status === "WAITING_APPROVAL" ||
      after.wave.status === "PAUSED" ||
      gated ||
      (after.wave.revision === before.wave.revision &&
        after.tickets.every((t, idx) => t.revision === before.tickets[idx]?.revision) &&
        after.outbox.every((item) => item.state === "SETTLED" || item.state === "FAILED"))
    ) {
      break;
    }
  }
  return inspect(ctrl, waveId);
}
