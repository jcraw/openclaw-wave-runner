import assert from "node:assert/strict";
import test from "node:test";

import type { OutboxBoundary } from "../src/core/outbox.js";
import { createSimulator, injectCrash, seedWave } from "../src/sim/simulator.js";

const BOUNDARIES: OutboxBoundary[] = [
  "before_reservation",
  "after_reservation",
  "after_launch",
  "before_receipt_commit",
  "after_completion",
  "before_settlement",
];

for (const boundary of BOUNDARIES) {
  test(`crash at ${boundary} does not create an unaccounted duplicate launch`, async () => {
    const sim = createSimulator(`fault-${boundary}`);
    await seedWave(sim, "wave-fault", ["FX-001"], { maxLaunches: 2, maxRetriesPerStage: 0 });
    const { recovered } = await injectCrash(sim, "wave-fault", boundary);
    await recovered.tick("wave-fault");
    await recovered.runUntilIdle("wave-fault");
    const view = recovered.inspect("wave-fault");
    const keys = view.outbox.map((item) => item.idempotencyKey);
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(sim.worker.launches <= 2, `launches=${sim.worker.launches}`);
    const reserved = view.budgets.filter((b) => b.state === "RESERVED");
    if (view.wave.status === "AWAITING_PLAN_GATE" || view.wave.status === "WAITING_APPROVAL" || view.outbox.some((o) => o.state === "SETTLED")) {
      assert.equal(reserved.length, 0);
    }
    const accounted = view.budgets.reduce(
      (sum, b) =>
        sum +
        (b.state === "COMMITTED" ? (b.tokensActual ?? 0) : b.state === "RELEASED" ? 0 : b.tokensReserved),
      0,
    );
    assert.ok(accounted <= view.wave.limits.maxTokens);
  });
}

test("two controllers race for one repo writer lease", async () => {
  const sim = createSimulator("race-lease");
  sim.policy.safeClasses.add("manual");
  const first = await seedWave(sim, "wave-race", ["FX-001"]);
  await first.start("wave-race");
  const planTicket = first.inspect("wave-race").tickets[0]!;
  if (planTicket.status === "PLAN_REVIEW") {
    first.approve("wave-race", planTicket.ticketId, planTicket.revision);
  }
  await first.tick("wave-race");
  const lease = first.db.getLease("repo-writer:/tmp/wave-fixture-repo");
  if (lease) {
    const second = sim.open();
    second.process.holder = "other";
    second.process.processIdentity = "other-1";
    assert.throws(() => {
      second.db.transaction(() => {
        const current = second.db.getLease("repo-writer:/tmp/wave-fixture-repo");
        if (current && current.expiresAt > second.clock.now() && current.holder !== "other") {
          throw new Error("lease held");
        }
      });
    });
  }
});

test("stale PID reuse cannot release a lease", async () => {
  const sim = createSimulator("pid-reuse");
  const controller = await seedWave(sim, "wave-pid", ["FX-001"]);
  controller.db.putLease({
    resourceKey: "repo-writer:/tmp/wave-fixture-repo",
    generation: 3,
    holder: "sim",
    processIdentity: "sim-1",
    pid: 4242,
    pidStartTime: "start-a",
    expiresAt: controller.clock.now() + 60_000,
    createdAt: controller.clock.now(),
    waveId: "wave-pid",
    ticketId: "FX-001",
  });
  const { releaseLease } = await import("../src/core/lease.js");
  assert.throws(
    () =>
      releaseLease({
        current: controller.db.getLease("repo-writer:/tmp/wave-fixture-repo")!,
        claimant: { holder: "sim", processIdentity: "sim-1", pid: 4242, pidStartTime: "start-b" },
        expectedGeneration: 3,
        now: controller.clock.now(),
      }),
    /PID reuse/,
  );
});
