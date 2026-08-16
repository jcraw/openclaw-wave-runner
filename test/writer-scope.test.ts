import assert from "node:assert/strict";
import test from "node:test";

import { deriveWriterScope, landLockKey, writerLeaseKey } from "../src/domain/writer-scope.js";
import { createSimulator, seedWave } from "../src/sim/simulator.js";

test("deriveWriterScope prefers product/game/board path", () => {
  assert.equal(deriveWriterScope({ ticketId: "GS-057", product: "godstones" }), "product:godstones");
  assert.equal(deriveWriterScope({ ticketId: "RR-068", game: "rink_rush" }), "game:rink_rush");
  assert.equal(
    deriveWriterScope({ ticketId: "GS-057", sourcePath: "issues/godstones/GS-057-x.md" }),
    "board:godstones",
  );
  assert.equal(
    deriveWriterScope({ ticketId: "AH-001", sourcePath: "game/jams/alien_haul/docs/x.md" }),
    "jam:alien_haul",
  );
  assert.equal(deriveWriterScope({ ticketId: "WR-011" }), "prefix:WR");
});

test("writerLeaseKey is repo+scope", () => {
  assert.equal(
    writerLeaseKey("/repo/game_jam", "board:godstones"),
    "writer:/repo/game_jam:board:godstones",
  );
  assert.equal(landLockKey("/repo/game_jam"), "land:/repo/game_jam");
});

test("WR-011: two different scopes can IMPL in parallel inside one wave", async () => {
  const sim = createSimulator("wr011-parallel");
  // Override fixtures to distinct board paths + manual plans.
  sim.tracker.seed({
    ticketId: "FX-001",
    title: "one",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/godstones/FX-001.md",
    planClass: "safe-policy",
    verifyCommand: "true",
    body: "one",
    writerScope: "board:godstones",
  });
  sim.tracker.seed({
    ticketId: "FX-002",
    title: "two",
    contentHash: "",
    dependsOn: [],
    order: 2,
    sourcePath: "issues/rink_rush/FX-002.md",
    planClass: "safe-policy",
    verifyCommand: "true",
    body: "two",
    writerScope: "board:rink_rush",
  });
  const controller = await seedWave(sim, "wave-par", ["FX-001", "FX-002"], {
    maxTokens: 80_000,
    maxLaunches: 8,
    perProviderConcurrency: 3,
    perStageReservationTokens: 8_000,
  });
  await controller.start("wave-par");
  await controller.runUntilIdle("wave-par");
  const final = controller.inspect("wave-par");
  const reopened = sim.open();
  const again = reopened.inspect("wave-par");
  const scopes = again.tickets.map((t) => t.writerScope);
  assert.ok(scopes.includes("board:godstones"));
  assert.ok(scopes.includes("board:rink_rush"));
  assert.equal(again.tickets.filter((t) => t.status === "DONE").length, 2);
  assert.equal(final.tickets.filter((t) => t.status === "DONE").length, 2);
});

test("WR-011: same scope stays exclusive on IMPL lease", async () => {
  const sim = createSimulator("wr011-serial");
  sim.tracker.seed({
    ticketId: "FX-001",
    title: "one",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/godstones/FX-001.md",
    planClass: "safe-policy",
    verifyCommand: "true",
    body: "one",
    writerScope: "board:godstones",
  });
  sim.tracker.seed({
    ticketId: "FX-002",
    title: "two",
    contentHash: "",
    dependsOn: [],
    order: 2,
    sourcePath: "issues/godstones/FX-002.md",
    planClass: "safe-policy",
    verifyCommand: "true",
    body: "two",
    writerScope: "board:godstones",
  });
  const controller = await seedWave(sim, "wave-ser", ["FX-001", "FX-002"], {
    maxTokens: 80_000,
    maxLaunches: 8,
    perProviderConcurrency: 3,
    perStageReservationTokens: 8_000,
  });
  await controller.start("wave-ser");
  let sawDoubleImpl = false;
  for (let i = 0; i < 16; i += 1) {
    await controller.tick("wave-ser");
    const view = controller.inspect("wave-ser");
    const implementing = view.tickets.filter((t) => t.status === "IMPLEMENTING");
    if (implementing.length > 1) sawDoubleImpl = true;
    if (view.wave.status === "COMPLETED") break;
  }
  assert.equal(sawDoubleImpl, false);
  const done = controller.inspect("wave-ser");
  assert.equal(done.tickets.filter((t) => t.status === "DONE").length, 2);
});
