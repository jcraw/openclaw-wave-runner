import type { LaunchOutbox } from "../domain/types.js";
import type { ControllerContext } from "./controller-context.js";
import { prepareImplContract } from "./impl-contract.js";
import { markFailed } from "./outbox.js";
import { forgeForWave } from "./plan-review-settle.js";
import type { LaunchIntent } from "./ports.js";

/** True when IMPL must not spawn (caller `continue`s). */
export function failClosedImplHandoff(
  ctrl: ControllerContext,
  waveId: string,
  claimed: LaunchOutbox,
  intent: LaunchIntent,
): boolean {
  if (claimed.stage !== "IMPL") return false;
  const prepared = prepareImplContract({
    stage: claimed.stage,
    forgeRoot: forgeForWave(ctrl, waveId),
    ticketId: claimed.ticketId,
    outputDir: intent.outputDir ?? ".",
  });
  if (prepared.ok) return false;
  ctrl.db.transaction(() => {
    const row = ctrl.db.getOutboxByIdempotency(claimed.idempotencyKey);
    if (row && row.state !== "SETTLED") {
      ctrl.db.putOutbox(markFailed(row, prepared.reason, ctrl.clock.now()));
    }
  });
  return true;
}
