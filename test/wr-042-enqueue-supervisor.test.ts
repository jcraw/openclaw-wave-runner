import assert from "node:assert/strict";
import test from "node:test";

import { countOpenProvider, DEFAULT_ACP_SLOTS, acpSlotCap } from "../src/core/acp-slots.js";
import { DEFAULT_LIMITS } from "../src/domain/types.js";
import { SAFETY } from "../src/domain/safety.js";
import { createSimulator, seedWave } from "../src/sim/simulator.js";

test("acp slot cap is min(wave, global) and defaults to 4", () => {
  assert.equal(DEFAULT_ACP_SLOTS, 4);
  assert.equal(SAFETY.supervisedAcpSlots, 4);
  assert.equal(acpSlotCap(5, 4), 4);
  assert.equal(acpSlotCap(2, 4), 2);
});

test("two slices on one ledger share ACP slots; second PLAN defers", async () => {
  const sim = createSimulator("wr-042-same-db");
  sim.tracker.seed({
    ticketId: "FX-010",
    title: "Independent fixture",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/FX-010.md",
    planClass: "manual",
    verifyCommand: "true",
    planReviewSkip: true,
    body: "ten",
  });
  const a = await seedWave(sim, "slice-a", ["FX-001"], {
    perStageReservationTokens: 8_000,
    maxLaunches: 8,
    perProviderConcurrency: 5,
  });
  a.acpSlotsMax = 1;
  const b = sim.open();
  b.acpSlotsMax = 1;
  await b.create({
    waveId: "slice-b",
    repoPath: "/tmp/wave-fixture-repo",
    ticketIds: ["FX-010"],
    limits: { ...DEFAULT_LIMITS, perStageReservationTokens: 8_000, maxLaunches: 8 },
  });

  await a.start("slice-a");
  await b.start("slice-b");
  await a.tickLive();

  const liveA = a.db.listOutbox("slice-a").filter((o) => o.state !== "SETTLED" && o.state !== "FAILED");
  const liveB = a.db.listOutbox("slice-b").filter((o) => o.state !== "SETTLED" && o.state !== "FAILED");
  assert.equal(liveA.length, 1, "first slice admitted PLAN");
  assert.equal(liveB.length, 0, "second slice deferred — same ACP pool");
  assert.equal(countOpenProvider(a.db, "mock"), 1);

  await a.runUntilIdle("slice-a");
  await a.tickLive();
  const afterB = a.db.listOutbox("slice-b");
  assert.ok(afterB.length >= 1, "second slice runs after the slot frees");
});

test("enqueueSlice adds a frozen slice the live tick loop can see", async () => {
  const sim = createSimulator("wr-042-enq");
  sim.tracker.seed({
    ticketId: "FX-010",
    title: "Independent fixture",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/FX-010.md",
    planClass: "manual",
    verifyCommand: "true",
    planReviewSkip: true,
    body: "ten",
  });
  const ctrl = await seedWave(sim, "slice-a", ["FX-001"], { maxLaunches: 8 });
  await ctrl.start("slice-a");
  const enq = await ctrl.enqueue({
    waveId: "slice-b",
    repoPath: "/tmp/wave-fixture-repo",
    ticketIds: ["FX-010"],
    limits: { ...DEFAULT_LIMITS, maxLaunches: 8 },
  });
  assert.equal(enq.wave.status, "RUNNING");
  assert.deepEqual(
    ctrl.db.listWaves().map((w) => w.waveId).sort(),
    ["slice-a", "slice-b"],
  );
  const ticked = await ctrl.tickLive();
  assert.ok(ticked.waveIds.includes("slice-a"));
  assert.ok(ticked.waveIds.includes("slice-b"));
});

test("two ledgers share occupancy via injected countLiveProvider", async () => {
  const simA = createSimulator("wr-042-db-a");
  const simB = createSimulator("wr-042-db-b");
  simB.tracker.seed({
    ticketId: "FX-010",
    title: "Independent fixture",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/FX-010.md",
    planClass: "manual",
    verifyCommand: "true",
    planReviewSkip: true,
    body: "ten",
  });
  const ctrlA = await seedWave(simA, "jam-slice", ["FX-001"], { maxLaunches: 8 });
  const ctrlB = simB.open();
  const count = (provider: string) =>
    countOpenProvider(ctrlA.db, provider) + countOpenProvider(ctrlB.db, provider);
  ctrlA.countLiveProvider = count;
  ctrlA.acpSlotsMax = 1;
  ctrlB.countLiveProvider = count;
  ctrlB.acpSlotsMax = 1;
  await ctrlB.create({
    waveId: "mud-slice",
    repoPath: "/tmp/wave-fixture-repo",
    ticketIds: ["FX-010"],
    limits: { ...DEFAULT_LIMITS, maxLaunches: 8 },
  });
  await ctrlA.start("jam-slice");
  await ctrlB.start("mud-slice");
  await ctrlA.tick("jam-slice");
  await ctrlB.tick("mud-slice");
  assert.equal(countOpenProvider(ctrlA.db, "mock"), 1);
  assert.equal(countOpenProvider(ctrlB.db, "mock"), 0);
});
