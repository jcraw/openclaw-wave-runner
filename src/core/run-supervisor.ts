import type { CreateWaveInput, SupervisedStartOptions, WaveView } from "../domain/types.js";
import { eventId as nextEventId, inspect, type ControllerContext } from "./controller-context.js";
import { isTerminalWave } from "./state-machine.js";
import { tickWave } from "./tick.js";
import { freezeWave, startWave } from "./wave-commands.js";
import { createWave } from "./wave-create.js";

export function liveWaveIds(ctrl: ControllerContext): string[] {
  return ctrl.db
    .listWaves()
    .filter((wave) => !isTerminalWave(wave.status))
    .map((wave) => wave.waveId);
}

export async function tickLiveWaves(
  ctrl: ControllerContext,
  options: SupervisedStartOptions = {},
): Promise<{ waveIds: string[]; views: WaveView[] }> {
  const waveIds = liveWaveIds(ctrl);
  const views: WaveView[] = [];
  for (const waveId of waveIds) {
    views.push(await tickWave(ctrl, waveId, options));
  }
  return { waveIds, views };
}

/** Freeze a new slice on this ledger and start it. Does not spawn an operator. */
export async function enqueueSlice(
  ctrl: ControllerContext,
  input: CreateWaveInput,
  eventId = nextEventId(),
): Promise<WaveView> {
  await createWave(ctrl, input, eventId);
  const created = inspect(ctrl, input.waveId);
  if (created.wave.status === "DRAFT") {
    freezeWave(ctrl, input.waveId, nextEventId());
  }
  return startWave(ctrl, input.waveId, nextEventId(), undefined, {
    supervisedBoundedPilot: input.supervisedBoundedPilot === true,
    operatorAction: input.operatorAction === true || input.supervisedBoundedPilot === true,
  });
}
