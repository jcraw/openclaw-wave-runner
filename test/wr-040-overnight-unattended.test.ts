import assert from "node:assert/strict";
import test from "node:test";

import { liveNeedsUx } from "../src/core/ux-review-skip.js";
import { stageDeathNoRetry } from "../src/core/settlement.js";
import { DEFAULT_LIMITS } from "../src/domain/types.js";
import { createSimulator, seedWave } from "../src/sim/simulator.js";

test("liveNeedsUx: freeze manifest wins over a dropped live row", () => {
  const manifest = JSON.stringify({
    tickets: [{ ticketId: "SP2-054", needsUx: true }],
  });
  assert.equal(liveNeedsUx({ ticketId: "SP2-054" }, manifest), true);
  assert.equal(liveNeedsUx({ ticketId: "SP2-054", needsUx: false }, manifest), true);
  assert.equal(liveNeedsUx({ ticketId: "SP2-054", needsUx: true }, manifest), true);
  assert.equal(liveNeedsUx({ ticketId: "SP2-099", needsUx: false }, manifest), false);
  assert.equal(liveNeedsUx({ ticketId: "SP2-054", needsUx: false }), false);
});

test("stageDeathNoRetry: Codex PLAN ACP_TURN_FAILED only", () => {
  assert.equal(
    stageDeathNoRetry({
      reason: "AcpRuntimeError [ACP_TURN_FAILED]: Internal error",
      stage: "PLAN",
      planWorker: "codex",
    }),
    true,
  );
  assert.equal(
    stageDeathNoRetry({
      reason: "AcpRuntimeError [ACP_TURN_FAILED]: Internal error",
      stage: "PLAN",
      planWorker: "grok",
    }),
    false,
  );
  assert.equal(
    stageDeathNoRetry({
      reason: "AcpRuntimeError [ACP_TURN_FAILED]: Internal error",
      stage: "IMPL",
      planWorker: "codex",
    }),
    false,
  );
  assert.equal(stageDeathNoRetry({ verifyFailSnippet: "missing_verify", reason: "x", stage: "PLAN" }), true);
  assert.equal(stageDeathNoRetry({ verifyFailSnippet: "stale_fence:1", reason: "x", stage: "IMPL" }), true);
});

test("dry-run reports codex_plan_unsafe; create still honors hybrid", async () => {
  const sim = createSimulator("wr040-codex-dry");
  sim.tracker.seed({
    ticketId: "SP2-063",
    title: "closer",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/SP2-063.md",
    verifyCommand: "true",
    provider: "hybrid",
    planWorker: "codex",
    body: "closer",
  });
  const controller = sim.open();
  const input = {
    waveId: "wave-codex",
    repoPath: "/tmp/wave-fixture-repo",
    ticketIds: ["SP2-063"],
    limits: { ...DEFAULT_LIMITS, maxLaunches: 12 },
  };
  const dry = await controller.dryRun(input);
  assert.ok(dry.admitBlockers.some((b) => b.code === "codex_plan_unsafe" && b.ticketId === "SP2-063"));
  await controller.create(input);
  assert.equal(controller.inspect("wave-codex").tickets[0]?.planWorker, "codex");
});

test("PLAN fail in apply mode does not copy or stamp applied", async () => {
  const sim = createSimulator("wr040-plan-apply");
  sim.tracker.seed({
    ticketId: "SP2-063",
    title: "closer",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/SP2-063.md",
    verifyCommand: "true",
    planReviewSkip: true,
    landMode: "apply",
    body: "closer",
  });
  const controller = await seedWave(sim, "wave-plan-fail", ["SP2-063"], {
    maxTokens: 80_000,
    maxLaunches: 8,
    maxRetriesPerStage: 0,
  });
  sim.worker.failNext = true;
  await controller.start("wave-plan-fail");
  await controller.runUntilIdle("wave-plan-fail");
  await controller.tick("wave-plan-fail");
  const ticket = controller.inspect("wave-plan-fail").tickets[0];
  assert.equal(ticket?.status, "FAILED");
  assert.equal(ticket?.stage, "PLAN");
  assert.doesNotMatch(ticket?.result ?? "", /\bapplied\b/);
  assert.equal(sim.workspace.applies, 0);
});
