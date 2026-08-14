import assert from "node:assert/strict";
import test from "node:test";

import { WaveRunnerM0Controller } from "../src/controller.js";
import { FakeOpenClawRuntime } from "./fakes.js";

test("creates, links, waits, survives restart, rejects stale approval, and finishes", async () => {
  const beforeRestart = new FakeOpenClawRuntime();
  const firstController = new WaveRunnerM0Controller(beforeRestart.ports());

  const started = await firstController.start("restart-proof");
  assert.equal(started.created, true);
  assert.equal(beforeRestart.launches, 1);
  assert.equal(started.state.frozen.maxLaunches, 1);
  assert.equal(started.state.frozen.repoWrites, false);

  const waiting = await firstController.settleChild(started.flow.flowId);
  assert.equal(waiting.flow.status, "waiting");
  assert.equal(waiting.state.stage, "waiting_approval");
  assert.equal(waiting.task.status, "succeeded");

  const restored = FakeOpenClawRuntime.restore(beforeRestart.snapshot());
  const afterRestart = new WaveRunnerM0Controller(restored.ports());
  const inspected = afterRestart.inspect(started.flow.flowId);
  assert.equal(inspected.flow.status, "waiting");
  assert.equal(inspected.state.manifestHash, waiting.state.manifestHash);
  assert.equal(restored.launches, 1);

  assert.throws(
    () => afterRestart.approve(started.flow.flowId, waiting.flow.revision - 1),
    /Stale approval revision/,
  );
  const finished = afterRestart.approve(started.flow.flowId, waiting.flow.revision);
  assert.equal(finished.flow.status, "succeeded");
  assert.equal(finished.state.stage, "finished");
  assert.equal(restored.launches, 1);
});

test("start is idempotent by wave id and does not duplicate a child launch", async () => {
  const runtime = new FakeOpenClawRuntime();
  const controller = new WaveRunnerM0Controller(runtime.ports());

  const first = await controller.start("same-wave");
  const second = await controller.start("same-wave");

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.flow.flowId, first.flow.flowId);
  assert.equal(runtime.launches, 1);
});

test("cancel is sticky and terminal in the second proof", async () => {
  const runtime = new FakeOpenClawRuntime();
  const controller = new WaveRunnerM0Controller(runtime.ports());

  const started = await controller.start("cancel-proof");
  const cancelled = await controller.cancel(started.flow.flowId);

  assert.equal(cancelled.found, true);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.flow?.status, "cancelled");
  assert.equal(cancelled.tasks?.[0]?.status, "cancelled");
  assert.equal(runtime.launches, 1);
  await assert.rejects(() => controller.settleChild(started.flow.flowId), /not awaiting child/);
});

test("frozen manifest is compact, stable, and isolated from unrelated state", async () => {
  const runtime = new FakeOpenClawRuntime();
  const controller = new WaveRunnerM0Controller(runtime.ports());

  const first = await controller.start("hash-proof");
  const hash = first.state.manifestHash;
  runtime.tasks.set("unrelated-task", { taskId: "unrelated-task", status: "failed" });
  const inspected = controller.inspect(first.flow.flowId);

  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(inspected.state.manifestHash, hash);
  assert.equal(inspected.state.frozen.selection, "m0-harmless-child-only");
  assert.equal(inspected.state.frozen.recurringScheduler, false);
});
