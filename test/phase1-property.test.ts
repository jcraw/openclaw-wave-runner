import assert from "node:assert/strict";
import test from "node:test";

import { isTerminalWave } from "../src/core/state-machine.js";
import { createSimulator, mulberry32, seedWave } from "../src/sim/simulator.js";

test("property: budget, concurrency, and finite-step invariants hold under random ops", async () => {
  const rng = mulberry32(42);
  for (let trial = 0; trial < 8; trial += 1) {
    const sim = createSimulator(`prop-${trial}`);
    const controller = await seedWave(sim, `wave-p${trial}`, ["FX-001", "FX-002"], {
      maxTokens: 40_000,
      perStageReservationTokens: 8_000,
      maxLaunches: 6,
      repoConcurrency: 1,
      perProviderConcurrency: 1,
    });
    await controller.start(`wave-p${trial}`);
    for (let step = 0; step < 20; step += 1) {
      const roll = rng();
      const view = controller.inspect(`wave-p${trial}`);
      if (isTerminalWave(view.wave.status)) break;
      try {
        if (roll < 0.15 && view.wave.status === "RUNNING") {
          controller.pause(`wave-p${trial}`);
        } else if (roll < 0.3 && view.wave.status === "PAUSED") {
          controller.resume(`wave-p${trial}`);
        } else if (roll < 0.35) {
          controller.cancel(`wave-p${trial}`);
        } else if (view.wave.status === "AWAITING_PLAN_GATE" || view.wave.status === "WAITING_APPROVAL") {
          const ticket = view.tickets.find((t) => t.status === "PLAN_REVIEW");
          if (ticket) controller.approve(`wave-p${trial}`, ticket.ticketId, ticket.revision);
        } else {
          await controller.tick(`wave-p${trial}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/Admission denied|cancelled|Duplicate event|Stale/.test(message)) {
          throw error;
        }
      }
    }
    const final = controller.inspect(`wave-p${trial}`);
    const used =
      final.wave.counters.committedTokens +
      final.wave.counters.reservedTokens +
      final.wave.counters.indeterminateTokens;
    assert.ok(used <= final.wave.limits.maxTokens, `tokens ${used} > ${final.wave.limits.maxTokens}`);
    assert.ok(final.wave.counters.launches <= final.wave.limits.maxLaunches);
    const writerLeases = final.leases.filter((l) => l.resourceKey.startsWith("repo-writer:"));
    assert.ok(writerLeases.length <= 1);
    assert.equal(sim.llmCalls.count, 0);
    controller.expireStaleLeases();
    assert.equal(sim.llmCalls.count, 0);
  }
});
