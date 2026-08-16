import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { SAFETY } from "../src/domain/safety.js";
import { deriveWriterScope } from "../src/domain/writer-scope.js";
import { DEFAULT_LIMITS } from "../src/domain/types.js";
import { shouldLandPush } from "../src/core/land-closeout.js";
import { createSimulator, seedWave } from "../src/sim/simulator.js";

test("persist: writerScope and humanHold survive reopen", async () => {
  const sim = createSimulator("wr018-persist");
  sim.tracker.seed({
    ticketId: "FX-001",
    title: "scoped",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/godstones/FX-001.md",
    planClass: "safe-policy",
    verifyCommand: "true",
    body: "one",
    writerScope: "product:other",
    humanHold: true,
    humanHoldReason: "needs_jason",
    product: "other",
  });
  const created = await seedWave(sim, "wave-persist", ["FX-001"]);
  const pathDerived = deriveWriterScope({
    ticketId: "FX-001",
    sourcePath: "issues/godstones/FX-001.md",
  });
  assert.equal(pathDerived, "board:godstones");
  const first = created.inspect("wave-persist").tickets[0];
  assert.equal(first?.writerScope, "product:other");
  assert.equal(first?.humanHold, true);
  assert.equal(first?.humanHoldReason, "needs_jason");
  assert.equal(first?.product, "other");
  created.db.close();
  const again = sim.open().inspect("wave-persist").tickets[0];
  assert.equal(again?.writerScope, "product:other");
  assert.equal(again?.humanHold, true);
  assert.equal(again?.humanHoldReason, "needs_jason");
  assert.equal(again?.product, "other");
  assert.notEqual(again?.writerScope, pathDerived);
});

test("missing verifyCommand fails IMPL with missing_verify", async () => {
  const sim = createSimulator("wr018-verify");
  sim.tracker.seed({
    ticketId: "FX-001",
    title: "no-verify",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/FX-001.md",
    planClass: "safe-policy",
    body: "one",
  });
  const controller = await seedWave(sim, "wave-verify", ["FX-001"]);
  await controller.start("wave-verify");
  await controller.runUntilIdle("wave-verify");
  const view = controller.inspect("wave-verify");
  const ticket = view.tickets[0];
  assert.equal(ticket?.status, "FAILED");
  assert.match(ticket?.result ?? "", /missing_verify/);
  assert.equal(sim.workspace.verifies, 0);
  assert.equal(sim.workspace.lands, 0);
});

test("land push is env-only; repo path does not imply push", async () => {
  const sim = createSimulator("wr018-push");
  sim.tracker.seed({
    ticketId: "FX-001",
    title: "push",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/FX-001.md",
    planClass: "safe-policy",
    verifyCommand: "true",
    body: "one",
  });
  const controller = sim.open();
  await controller.create({
    waveId: "wave-push",
    repoPath: "/tmp/openclaw-wave-runner-fixture",
    ticketIds: ["FX-001"],
    limits: DEFAULT_LIMITS,
  });
  const prev = process.env.WAVE_LAND_PUSH;
  delete process.env.WAVE_LAND_PUSH;
  try {
    assert.equal(shouldLandPush({}), false);
    await controller.start("wave-push");
    await controller.runUntilIdle("wave-push");
    assert.equal(controller.inspect("wave-push").tickets[0]?.status, "DONE");
    assert.ok(sim.workspace.lands >= 1);
    const worktree = controller.inspect("wave-push").tickets[0]?.implWorktree;
    assert.ok(worktree);
    const land = JSON.parse(readFileSync(join(worktree, "LAND.json"), "utf8")) as { push?: boolean };
    assert.equal(land.push, false);
  } finally {
    if (prev === undefined) delete process.env.WAVE_LAND_PUSH;
    else process.env.WAVE_LAND_PUSH = prev;
  }
});

test("stale fence: expired lease does not land", async () => {
  const sim = createSimulator("wr018-fence");
  sim.tracker.seed({
    ticketId: "FX-001",
    title: "fence",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/FX-001.md",
    planClass: "safe-policy",
    verifyCommand: "true",
    body: "one",
  });
  const controller = await seedWave(sim, "wave-fence", ["FX-001"]);
  sim.worker.completeOnInspect = false;
  await controller.start("wave-fence");
  for (let i = 0; i < 16; i += 1) {
    await controller.tick("wave-fence");
    const launched = controller
      .inspect("wave-fence")
      .outbox.find((item) => item.stage === "IMPL" && (item.state === "LAUNCHED" || item.state === "CLAIMED"));
    if (launched) break;
    const plan = controller.inspect("wave-fence").outbox.find((item) => item.stage === "PLAN");
    if (plan && (plan.state === "LAUNCHED" || plan.state === "CLAIMED")) {
      sim.worker.completeOnInspect = true;
      await controller.tick("wave-fence");
      sim.worker.completeOnInspect = false;
    }
  }
  const before = controller.inspect("wave-fence");
  assert.ok(before.outbox.some((item) => item.stage === "IMPL"));
  sim.clock.advance(120_000);
  controller.expireStaleLeases();
  sim.worker.completeOnInspect = true;
  await controller.runUntilIdle("wave-fence");
  const after = controller.inspect("wave-fence");
  assert.notEqual(after.tickets[0]?.status, "DONE");
  assert.match(after.tickets[0]?.result ?? "", /stale_fence|missing_verify|FAILED/i);
  assert.equal(sim.workspace.lands, 0);
});

test("capabilities match SAFETY supervised flags", async () => {
  const sim = createSimulator("wr018-caps");
  const caps = sim.open().capabilities() as {
    supervisedBoundedLaunchAllowed: boolean;
    supervisedOneTicketLaunchAllowed: boolean;
  };
  assert.equal(caps.supervisedBoundedLaunchAllowed, SAFETY.supervisedBoundedLaunchAllowed);
  assert.equal(caps.supervisedOneTicketLaunchAllowed, SAFETY.supervisedOneTicketLaunchAllowed);
});

test("USD quota mode fails closed at create and dry-run", async () => {
  const sim = createSimulator("wr018-usd");
  const controller = sim.open();
  await assert.rejects(
    () =>
      controller.dryRun({
        waveId: "wave-usd",
        repoPath: "/tmp/wave-fixture-repo",
        ticketIds: ["FX-001"],
        limits: DEFAULT_LIMITS,
        quotaMode: "usd",
      }),
    /USD quota/,
  );
  await assert.rejects(
    () =>
      controller.create({
        waveId: "wave-usd",
        repoPath: "/tmp/wave-fixture-repo",
        ticketIds: ["FX-001"],
        limits: DEFAULT_LIMITS,
        quotaMode: "usd",
      }),
    /USD quota/,
  );
});
