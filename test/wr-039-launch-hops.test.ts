import assert from "node:assert/strict";
import test from "node:test";

import { hopsExceedBlockers, hopsForTicket, requiredLaunches } from "../src/core/launch-hops.js";
import { SAFETY } from "../src/domain/safety.js";
import { DEFAULT_LIMITS, SUPERVISED_PILOT_LIMITS } from "../src/domain/types.js";
import { createSimulator, seedWave } from "../src/sim/simulator.js";

test("hops: skip / crawmak / needs_ux", () => {
  assert.equal(hopsForTicket({ planReviewSkip: true }), 2);
  assert.equal(hopsForTicket({}), 3);
  assert.equal(hopsForTicket({ needsUx: true }), 4);
  assert.equal(hopsForTicket({ planReviewSkip: true, needsUx: true }), 3);
  assert.equal(
    requiredLaunches([
      { needsUx: true },
      { needsUx: true },
      { planReviewSkip: true },
    ]),
    4 + 4 + 2,
  );
});

test("eight needs_ux tickets fit the supervised launch cap", () => {
  const tickets = Array.from({ length: 8 }, (_, i) => ({
    ticketId: `SP2-0${50 + i}`,
    needsUx: true as const,
  }));
  const need = requiredLaunches(tickets);
  assert.equal(need, 32);
  assert.ok(need <= SAFETY.supervisedMaxLaunches);
  assert.equal(SUPERVISED_PILOT_LIMITS.maxLaunches, SAFETY.supervisedMaxLaunches);
  assert.equal(hopsExceedBlockers(tickets, 10).length, 8);
  assert.equal(hopsExceedBlockers(tickets, 32).length, 0);
});

test("dry-run reports hops_exceed_max_launches", async () => {
  const sim = createSimulator("wr-039-dry");
  const controller = sim.open();
  const dry = await controller.dryRun({
    waveId: "wave-hops-dry",
    repoPath: "/fixture/repo",
    ticketIds: ["FX-001", "FX-002"],
    limits: { ...DEFAULT_LIMITS, maxLaunches: 1 },
  });
  assert.ok(dry.admitBlockers.some((b) => b.code === "hops_exceed_max_launches"));
});

test("idle max_launches stops the wave instead of throwing", async () => {
  const sim = createSimulator("wr-039-stop");
  const controller = await seedWave(sim, "wave-cap", ["FX-001"], {
    maxTokens: 80_000,
    perStageReservationTokens: 8_000,
    maxLaunches: 1,
  });
  await controller.start("wave-cap");
  await controller.runUntilIdle("wave-cap");
  await controller.tick("wave-cap");
  const view = controller.inspect("wave-cap");
  assert.equal(view.wave.status, "BUDGET_STOPPED");
  assert.match(String(view.tickets[0]?.result), /max_launches/);
});
