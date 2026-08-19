import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_LIMITS } from "../src/domain/types.js";
import { createSimulator, seedWave } from "../src/sim/simulator.js";

test("Phase 3: 3-ticket dependency wave with serial writer and mixed approval", async () => {
  const sim = createSimulator("p3-three");
  const controller = await seedWave(sim, "wave-3", ["FX-001", "FX-002", "FX-003"], {
    maxTokens: 80_000,
    perStageReservationTokens: 8_000,
    maxLaunches: 8,
    perProviderConcurrency: 1,
    repoConcurrency: 1,
  });
  await controller.start("wave-3");
  await controller.runUntilIdle("wave-3");
  let view = controller.inspect("wave-3");
  assert.equal(view.tickets[0]?.ticketId, "FX-001");
  assert.equal(view.tickets.find((t) => t.ticketId === "FX-001")?.status, "DONE");
  view = controller.inspect("wave-3");
  assert.ok(["COMPLETED", "RUNNING"].includes(view.wave.status));
  assert.ok(view.leases.filter((l) => l.resourceKey.startsWith("writer:")).length <= 1);
  const projection = controller.project();
  assert.equal(projection.authoritative, false);
  assert.equal(projection.productionDrainEnabled, false);
  assert.ok(projection.waves[0]?.artifacts);
});

test("Phase 3: mid-wave ticket is excluded from frozen manifest", async () => {
  const sim = createSimulator("p3-mid");
  const controller = await seedWave(sim, "wave-mid", ["FX-001"]);
  controller.freeze("wave-mid");
  sim.tracker.seed({
    ticketId: "FX-999",
    title: "late",
    contentHash: "late",
    dependsOn: [],
    order: 9,
    sourcePath: "issues/FX-999.md",
    body: "should not enter",
  });
  const view = controller.inspect("wave-mid");
  assert.deepEqual(
    view.manifest.tickets.map((t) => t.ticketId),
    ["FX-001"],
  );
});

test("Phase 3: synthetic MUD-034 plus fourteen children stops at budget/manifest boundary", async () => {
  const sim = createSimulator("p3-mud");
  const ids = ["MUD-034"];
  for (let i = 1; i <= 14; i += 1) {
    const id = `MUD-C${String(i).padStart(2, "0")}`;
    ids.push(id);
    sim.tracker.seed({
      ticketId: id,
      title: id,
      contentHash: "",
      dependsOn: ["MUD-034"],
      order: i + 1,
      sourcePath: `issues/${id}.md`,
      planClass: "safe-policy",
      verifyCommand: "true",
      body: id,
    });
  }
  sim.tracker.seed({
    ticketId: "MUD-034",
    title: "parent",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/MUD-034.md",
    planClass: "manual",
    verifyCommand: "true",
    body: "parent",
  });
  const controller = sim.open();
  await controller.create({
    waveId: "wave-mud",
    repoPath: "/tmp/wave-fixture-repo",
    ticketIds: ids,
    limits: {
      ...DEFAULT_LIMITS,
      maxTokens: 16_000,
      perStageReservationTokens: 8_000,
      maxLaunches: 2,
    },
  });
  await controller.start("wave-mud");
  try {
    await controller.runUntilIdle("wave-mud");
  } catch (err) {
    assert.match(String(err), /Admission denied|max_launches|token ceiling/);
  }
  const view = controller.inspect("wave-mud");
  assert.ok(view.wave.counters.launches <= 2);
  assert.ok(
    view.wave.counters.committedTokens +
      view.wave.counters.reservedTokens +
      view.wave.counters.indeterminateTokens <=
      16_000,
  );
  assert.equal(view.manifest.tickets.length, 15);
  const unfinished = view.tickets.filter((t) => t.status === "PENDING");
  assert.ok(unfinished.length >= 14);
});

test("Phase 3: watchdog intervals never call an LLM", async () => {
  const sim = createSimulator("p3-watch");
  const controller = await seedWave(sim, "wave-watch", ["FX-001"]);
  controller.db.putLease({
    resourceKey: "repo-writer:/tmp/stale",
    generation: 1,
    holder: "dead",
    processIdentity: "dead-1",
    expiresAt: controller.clock.now() - 1,
    createdAt: controller.clock.now() - 10_000,
  });
  for (let i = 0; i < 10; i += 1) {
    sim.clock.advance(1_000);
    controller.expireStaleLeases();
  }
  assert.equal(controller.watchdogFires, 10);
  assert.equal(sim.llmCalls.count, 0);
  assert.equal(controller.db.getLease("repo-writer:/tmp/stale"), undefined);
});
