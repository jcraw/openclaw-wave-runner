import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GrokAcpWorker } from "../src/adapters/acp-worker.js";
import type { AcpSpawn, AcpSpawnResult, LaunchIntent } from "../src/adapters/ports.js";
import { stageAttemptDir, stageSessionKey, writeStageTerminal } from "../src/adapters/stage-artifacts.js";

class FakeAcp implements AcpSpawn {
  launches = 0;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "lost" | "unknown" = "running";
  readonly bySource = new Map<string, AcpSpawnResult>();
  lastTask?: string;
  lastRequest?: Parameters<AcpSpawn["spawn"]>[0];

  async spawn(request: Parameters<AcpSpawn["spawn"]>[0]) {
    const existing = this.bySource.get(request.sourceId);
    if (existing) return existing;
    this.launches += 1;
    this.lastTask = request.task;
    this.lastRequest = request;
    const result = { taskId: `task-${request.sourceId}`, runId: `run-${request.sourceId}`, sessionId: request.sessionKey };
    this.bySource.set(request.sourceId, result);
    return result;
  }

  async inspect() { return { status: this.status }; }
  async cancel() { this.status = "cancelled"; return { cancelled: true }; }
  async findBySourceId(sourceId: string) { return this.bySource.get(sourceId); }
}

function intent(root: string, stage: "PLAN" | "IMPL" | "VERIFY", attempt = 1): LaunchIntent {
  const waveId = "wave-a";
  const ticketId = "MUD-036";
  return {
    idempotencyKey: `${waveId}:${ticketId}:${stage}:${attempt}`,
    waveId,
    ticketId,
    stage,
    attempt,
    prompt: `${stage} ${ticketId}`,
    sessionKey: stageSessionKey({ waveId, ticketId, stage, attempt }),
    worktree: root,
    outputDir: stageAttemptDir({ root, waveId, ticketId, stage, attempt }),
    approvedPlanPath: stage === "PLAN" ? undefined : join(root, "approved-plan.md"),
  };
}

test("ACP product stages use distinct attempt directories and fresh session keys", async () => {
  const root = mkdtempSync(join(tmpdir(), "wave-acp-stage-"));
  writeFileSync(join(root, "approved-plan.md"), "# approved\n", "utf8");
  const acp = new FakeAcp();
  const worker = new GrokAcpWorker({ acp });
  const plan = intent(root, "PLAN");
  const impl = intent(root, "IMPL");
  const planReceipt = await worker.launch(plan);
  const implReceipt = await worker.launch(impl);
  assert.notEqual(planReceipt.outputDir, implReceipt.outputDir);
  assert.notEqual(planReceipt.sessionId, implReceipt.sessionId);
  assert.equal(acp.launches, 2);
  assert.match(acp.lastTask ?? "", /Do not resume the PLAN conversation/);
  assert.doesNotMatch(acp.lastTask ?? "", /^IMPL MUD-036$/);
  assert.equal(acp.lastRequest?.model, undefined, "Grok is pinned in argv; do not call ACP model switching");
});

test("live IMPL ACP task stays running even when stale PLAN artifacts exist", async () => {
  const root = mkdtempSync(join(tmpdir(), "wave-acp-live-"));
  writeFileSync(join(root, "approved-plan.md"), "# approved\n", "utf8");
  const acp = new FakeAcp();
  const worker = new GrokAcpWorker({ acp });
  const impl = intent(root, "IMPL");
  const receipt = await worker.launch(impl);
  writeFileSync(join(receipt.outputDir!, "PLAN.md"), "# stale plan\n", "utf8");
  const truth = await worker.inspect(receipt);
  assert.equal(truth.status, "running");
});

test("receipt recovery adopts the ACP task by source id and never respawns", async () => {
  const root = mkdtempSync(join(tmpdir(), "wave-acp-recover-"));
  const acp = new FakeAcp();
  const first = new GrokAcpWorker({ acp });
  const launchIntent = intent(root, "PLAN");
  const receipt = await first.launch(launchIntent);
  assert.equal(acp.launches, 1);
  const restarted = new GrokAcpWorker({ acp });
  const recovered = await restarted.recover(launchIntent);
  assert.equal(recovered?.runId, receipt.runId);
  await restarted.launch(launchIntent);
  assert.equal(acp.launches, 1);
});

test("missing receipt and missing ACP task remain unknown without a second launch", async () => {
  const root = mkdtempSync(join(tmpdir(), "wave-acp-missing-"));
  const acp = new FakeAcp();
  const worker = new GrokAcpWorker({ acp });
  assert.equal(await worker.recover(intent(root, "PLAN")), undefined);
  assert.equal(acp.launches, 0);
});

test("terminal attestation with the wrong stage is rejected", async () => {
  const root = mkdtempSync(join(tmpdir(), "wave-acp-terminal-"));
  writeFileSync(join(root, "approved-plan.md"), "# approved\n", "utf8");
  const acp = new FakeAcp();
  const worker = new GrokAcpWorker({ acp });
  const impl = intent(root, "IMPL");
  const receipt = await worker.launch(impl);
  writeFileSync(join(receipt.outputDir!, "IMPL_DONE.json"), '{"ok":true}\n', "utf8");
  writeStageTerminal(receipt.outputDir!, {
    idempotencyKey: impl.idempotencyKey,
    waveId: impl.waveId,
    ticketId: impl.ticketId,
    stage: "PLAN",
    attempt: 1,
    status: "succeeded",
  });
  acp.status = "succeeded";
  const truth = await worker.inspect(receipt);
  assert.equal(truth.status, "unknown");
  assert.match(truth.error ?? "", /mismatched/);
});

test("durable stage artifacts win over late ACP cancel/timeout", async () => {
  const root = mkdtempSync(join(tmpdir(), "wave-acp-cancel-race-"));
  const acp = new FakeAcp();
  const worker = new GrokAcpWorker({ acp });
  const plan = intent(root, "PLAN");
  const receipt = await worker.launch(plan);
  writeFileSync(join(receipt.outputDir!, "PLAN.md"), "# plan\n", "utf8");
  writeStageTerminal(receipt.outputDir!, {
    idempotencyKey: plan.idempotencyKey,
    waveId: plan.waveId,
    ticketId: plan.ticketId,
    stage: "PLAN",
    attempt: 1,
    status: "succeeded",
  });
  acp.status = "cancelled";
  const truth = await worker.inspect(receipt);
  assert.equal(truth.status, "succeeded");
  assert.equal(truth.outputRef, receipt.outputDir);
});
