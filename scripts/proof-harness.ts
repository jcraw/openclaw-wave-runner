import assert from "node:assert/strict";

import { WaveRunnerM0Controller } from "../src/controller.js";
import { FakeOpenClawRuntime } from "../test/fakes.js";

const firstRuntime = new FakeOpenClawRuntime();
const firstController = new WaveRunnerM0Controller(firstRuntime.ports());
const started = await firstController.start("deterministic-restart-proof");
const waiting = await firstController.settleChild(started.flow.flowId);

const restartedRuntime = FakeOpenClawRuntime.restore(firstRuntime.snapshot());
const restartedController = new WaveRunnerM0Controller(restartedRuntime.ports());
const afterRestart = restartedController.inspect(started.flow.flowId);
assert.equal(afterRestart.flow.status, "waiting");
assert.equal(restartedRuntime.launches, 1);
const finished = restartedController.approve(started.flow.flowId, afterRestart.flow.revision);

const cancelRuntime = new FakeOpenClawRuntime();
const cancelController = new WaveRunnerM0Controller(cancelRuntime.ports());
const cancelStarted = await cancelController.start("deterministic-cancel-proof");
const cancelled = await cancelController.cancel(cancelStarted.flow.flowId);

const proof = {
  ok: true,
  restartProof: {
    flowId: started.flow.flowId,
    manifestHash: waiting.state.manifestHash,
    statusBeforeRestart: waiting.flow.status,
    statusAfterRestart: afterRestart.flow.status,
    terminalStatus: finished.flow.status,
    childLaunches: restartedRuntime.launches,
    linkedTaskStatus: afterRestart.task?.status,
  },
  cancellationProof: {
    flowId: cancelStarted.flow.flowId,
    flowStatus: cancelled.flow?.status,
    linkedTaskStatus: cancelled.tasks?.[0]?.status,
    childLaunches: cancelRuntime.launches,
  },
  constraints: {
    backlogScan: false,
    productRepoWrites: false,
    grokOrCodexCli: false,
    recurringScheduler: false,
    gatewayConfigMutation: false,
    internalSqliteAccess: false,
  },
};

console.log(JSON.stringify(proof, null, 2));
