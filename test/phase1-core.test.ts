import assert from "node:assert/strict";
import test from "node:test";

import { DuplicateEventError } from "../src/domain/errors.js";
import { SAFETY } from "../src/domain/safety.js";
import { DEFAULT_LIMITS } from "../src/domain/types.js";
import { hashManifest, validateTicketGraph } from "../src/core/manifest.js";
import { createSimulator, seedWave } from "../src/sim/simulator.js";
import { runOperator } from "../src/cli/operations.js";

test("schema migrates and freeze hashes are immutable", async () => {
  const sim = createSimulator("p1-hash");
  const controller = await seedWave(sim, "wave-hash", ["FX-001"]);
  assert.equal(controller.db.schemaVersion(), 3);
  const frozen = controller.freeze("wave-hash");
  const hash = frozen.wave.manifestHash;
  assert.match(hash, /^[a-f0-9]{64}$/);
  sim.tracker.seed({
    ticketId: "FX-999",
    title: "late ticket",
    contentHash: "x",
    dependsOn: [],
    order: 9,
    sourcePath: "issues/FX-999.md",
    body: "late",
  });
  const again = controller.inspect("wave-hash");
  assert.equal(again.wave.manifestHash, hash);
  assert.equal(again.manifest.tickets.length, 1);
  assert.equal(hashManifest(again.manifest), hash);
  assert.equal(again.manifest.drainEverything, false);
});

test("missing dependency and cycles fail freeze", () => {
  assert.throws(
    () =>
      validateTicketGraph([
        {
          ticketId: "A",
          title: "A",
          contentHash: "1",
          dependsOn: ["B"],
          order: 1,
          sourcePath: "A.md",
        },
      ]),
    /Missing dependency/,
  );
  assert.throws(
    () =>
      validateTicketGraph([
        {
          ticketId: "A",
          title: "A",
          contentHash: "1",
          dependsOn: ["B"],
          order: 1,
          sourcePath: "A.md",
        },
        {
          ticketId: "B",
          title: "B",
          contentHash: "2",
          dependsOn: ["A"],
          order: 2,
          sourcePath: "B.md",
        },
      ]),
    /cycle/,
  );
});

test("duplicate events are no-op errors and stale revision is rejected", async () => {
  const sim = createSimulator("p1-dup");
  const controller = await seedWave(sim, "wave-dup", ["FX-001"]);
  controller.freeze("wave-dup", "evt-freeze");
  assert.throws(() => controller.freeze("wave-dup", "evt-freeze"), DuplicateEventError);
  await assert.rejects(() => controller.start("wave-dup", "evt-start", 0), /Stale revision/);
});

test("operator CLI dry-run/create/inspect/pause/cancel", async () => {
  const sim = createSimulator("p1-cli");
  const controller = sim.open();
  const input = {
    waveId: "wave-cli",
    repoPath: "/tmp/wave-fixture-repo",
    ticketIds: ["FX-001"],
    limits: DEFAULT_LIMITS,
  };
  const dry = await runOperator(controller, { op: "dry-run", input });
  assert.equal((dry as { ok: boolean }).ok, true);
  await runOperator(controller, { op: "create", input });
  const inspected = await runOperator(controller, { op: "inspect", waveId: "wave-cli" });
  assert.equal((inspected as { wave: { status: string } }).wave.status, "DRAFT");
  await runOperator(controller, { op: "freeze", waveId: "wave-cli" });
  await runOperator(controller, { op: "start", waveId: "wave-cli" });
  await runOperator(controller, { op: "pause", waveId: "wave-cli" });
  const paused = controller.inspect("wave-cli");
  assert.equal(paused.wave.status, "PAUSED");
  await runOperator(controller, { op: "cancel", waveId: "wave-cli" });
  assert.equal(controller.inspect("wave-cli").wave.status, "CANCELLED");
  const caps = await runOperator(controller, { op: "capabilities" });
  assert.equal((caps as { productionDrainEnabled: boolean }).productionDrainEnabled, false);
  assert.equal(SAFETY.productionDrainEnabled, false);
});

test("INDETERMINATE fail-closed usage keeps full reservation", async () => {
  const sim = createSimulator("p1-indet");
  sim.usage.mode = "indeterminate";
  const controller = await seedWave(sim, "wave-indet", ["FX-001"], {
    maxTokens: 8_000,
    perStageReservationTokens: 8_000,
    maxLaunches: 2,
  });
  await controller.start("wave-indet");
  await controller.runUntilIdle("wave-indet");
  const waiting = controller.inspect("wave-indet");
  assert.equal(waiting.wave.status, "AWAITING_PLAN_GATE");
  const budget = waiting.budgets[0];
  assert.ok(budget);
  assert.equal(budget.state, "INDETERMINATE");
  assert.equal(budget.tokensReserved, 8_000);
  assert.equal(waiting.wave.counters.indeterminateTokens, 8_000);
  const ticket = waiting.tickets[0]!;
  controller.approve("wave-indet", ticket.ticketId, ticket.revision);
  await assert.rejects(() => controller.tick("wave-indet"), /Admission denied|token ceiling/);
});

test("budget admission refuses the next candidate atomically", async () => {
  const sim = createSimulator("p1-budget");
  const controller = await seedWave(sim, "wave-budget", ["FX-001"], {
    maxTokens: 8_000,
    perStageReservationTokens: 8_000,
    maxLaunches: 1,
  });
  await controller.start("wave-budget");
  await controller.runUntilIdle("wave-budget");
  const view = controller.inspect("wave-budget");
  assert.ok(view.outbox.length >= 1, "first stage must be admitted");
  assert.ok(view.wave.counters.launches >= 1);
  const ticket = view.tickets[0]!;
  if (ticket.status === "PLAN_REVIEW") {
    controller.approve("wave-budget", ticket.ticketId, ticket.revision);
  }
  await assert.rejects(() => controller.tick("wave-budget"), /Admission denied|max_launches|token ceiling/);
  const after = controller.inspect("wave-budget");
  assert.equal(after.wave.counters.launches, view.wave.counters.launches);
});

const CHAIN_LIMITS = {
  maxTokens: 80_000,
  perStageReservationTokens: 8_000,
  maxLaunches: 8,
  // Explicit zero so mid-chain death tests stay one-shot (defaults now retry once).
  maxRetriesPerStage: 0,
};

async function driveFx001ToDone(controller: Awaited<ReturnType<typeof seedWave>>, waveId: string) {
  await controller.start(waveId);
  await controller.runUntilIdle(waveId);
  const waiting = controller.inspect(waveId);
  assert.equal(waiting.wave.status, "AWAITING_PLAN_GATE");
  const first = waiting.tickets.find((t) => t.ticketId === "FX-001");
  assert.ok(first);
  controller.approve(waveId, first.ticketId, first.revision);
  for (let i = 0; i < 8; i += 1) {
    if (controller.inspect(waveId).tickets.find((t) => t.ticketId === "FX-001")?.status === "DONE") {
      return;
    }
    await controller.tick(waveId);
  }
  assert.equal(controller.inspect(waveId).tickets.find((t) => t.ticketId === "FX-001")?.status, "DONE");
}

async function killFx002Plan(
  sim: ReturnType<typeof createSimulator>,
  controller: Awaited<ReturnType<typeof seedWave>>,
  waveId: string,
  status: "cancelled" | "failed",
) {
  await driveFx001ToDone(controller, waveId);
  sim.worker.completeOnInspect = false;
  const key = `${waveId}:FX-002:PLAN:1`;
  if (!sim.worker.byKey.has(key)) {
    await controller.tick(waveId);
  }
  const row = sim.worker.byKey.get(key);
  assert.ok(row, "FX-002 PLAN must have launched");
  row.status = status;
  await controller.runUntilIdle(waveId);
}

test("mid-chain PLAN cancel fails dependents and the wave", async () => {
  const sim = createSimulator("p1-mid-cancel");
  const controller = await seedWave(sim, "wave-mid-cancel", ["FX-001", "FX-002", "FX-003"], CHAIN_LIMITS);
  await killFx002Plan(sim, controller, "wave-mid-cancel", "cancelled");
  const view = controller.inspect("wave-mid-cancel");
  assert.equal(view.tickets.find((t) => t.ticketId === "FX-001")?.status, "DONE");
  // Worker cancel (not operator) exhausts as FAILED with a durable reason.
  const mid = view.tickets.find((t) => t.ticketId === "FX-002");
  assert.equal(mid?.status, "FAILED");
  assert.ok((mid?.result ?? "").length > 0, "death reason must be persisted");
  const tail = view.tickets.find((t) => t.ticketId === "FX-003");
  assert.equal(tail?.status, "FAILED");
  assert.equal(tail?.result, "dependency FX-002 failed");
  assert.equal(view.wave.status, "FAILED");
  assert.equal(view.wave.cancelRequested, false);
  assert.ok(!view.outbox.some((item) => item.ticketId === "FX-003"));
  assert.ok(!sim.worker.intents.some((intent) => intent.ticketId === "FX-003"));
  const launches = view.wave.counters.launches;
  const workerLaunches = sim.worker.launches;
  await controller.tick("wave-mid-cancel");
  const again = controller.inspect("wave-mid-cancel");
  assert.equal(again.wave.status, "FAILED");
  assert.equal(again.wave.counters.launches, launches);
  assert.equal(sim.worker.launches, workerLaunches);
});

test("empty PLAN cancel retries once then fails (WR-010)", async () => {
  const sim = createSimulator("p1-plan-retry");
  const limits = { ...CHAIN_LIMITS, maxRetriesPerStage: 1, maxLaunches: 6 };
  const controller = await seedWave(sim, "wave-plan-retry", ["FX-001"], limits);
  await controller.start("wave-plan-retry");
  sim.worker.completeOnInspect = false;
  // Launch PLAN:1
  await controller.tick("wave-plan-retry");
  const key1 = "wave-plan-retry:FX-001:PLAN:1";
  assert.ok(sim.worker.byKey.has(key1));
  sim.worker.byKey.get(key1)!.status = "cancelled";
  // Settle re-arms REVISING then same tick may advance into PLAN:2 / PLANNING.
  await controller.tick("wave-plan-retry");
  let view = controller.inspect("wave-plan-retry");
  const afterFirst = view.tickets.find((t) => t.ticketId === "FX-001");
  assert.ok(
    afterFirst?.status === "REVISING" || afterFirst?.status === "PLANNING",
    `expected REVISING or PLANNING after first cancel, got ${afterFirst?.status}`,
  );
  assert.match(afterFirst?.result ?? "", /retry 2 after/i);
  assert.equal(view.wave.status, "RUNNING");
  // Ensure PLAN:2 is live (may already be launched by the settle tick).
  for (let i = 0; i < 4 && !sim.worker.byKey.has("wave-plan-retry:FX-001:PLAN:2"); i += 1) {
    await controller.tick("wave-plan-retry");
  }
  const key2 = "wave-plan-retry:FX-001:PLAN:2";
  assert.ok(sim.worker.byKey.has(key2), "second PLAN attempt must launch");
  sim.worker.byKey.get(key2)!.status = "cancelled";
  await controller.runUntilIdle("wave-plan-retry");
  view = controller.inspect("wave-plan-retry");
  const dead = view.tickets.find((t) => t.ticketId === "FX-001");
  assert.equal(dead?.status, "FAILED");
  assert.ok((dead?.result ?? "").length > 0, "exhausted retry must keep a reason");
  assert.equal(view.wave.status, "FAILED");
  assert.equal(view.stages.filter((s) => s.ticketId === "FX-001" && s.stage === "PLAN").length, 2);
});

test("mid-chain PLAN fail fails dependents and the wave", async () => {
  const sim = createSimulator("p1-mid-fail");
  const controller = await seedWave(sim, "wave-mid-fail", ["FX-001", "FX-002", "FX-003"], CHAIN_LIMITS);
  await killFx002Plan(sim, controller, "wave-mid-fail", "failed");
  const view = controller.inspect("wave-mid-fail");
  assert.equal(view.tickets.find((t) => t.ticketId === "FX-001")?.status, "DONE");
  assert.equal(view.tickets.find((t) => t.ticketId === "FX-002")?.status, "FAILED");
  const tail = view.tickets.find((t) => t.ticketId === "FX-003");
  assert.equal(tail?.status, "FAILED");
  assert.equal(tail?.result, "dependency FX-002 failed");
  assert.equal(view.wave.status, "FAILED");
  assert.ok(!view.outbox.some((item) => item.ticketId === "FX-003"));
  assert.ok(!sim.worker.intents.some((intent) => intent.ticketId === "FX-003"));
  const launches = view.wave.counters.launches;
  await controller.tick("wave-mid-fail");
  assert.equal(controller.inspect("wave-mid-fail").wave.status, "FAILED");
  assert.equal(controller.inspect("wave-mid-fail").wave.counters.launches, launches);
});

test("operator cancel-all stays CANCELLED before any ticket is DONE", async () => {
  const sim = createSimulator("p1-op-cancel");
  const controller = await seedWave(sim, "wave-op-cancel", ["FX-001", "FX-002", "FX-003"], CHAIN_LIMITS);
  await controller.start("wave-op-cancel");
  controller.cancel("wave-op-cancel");
  const view = controller.inspect("wave-op-cancel");
  assert.equal(view.wave.status, "CANCELLED");
  assert.equal(view.wave.cancelRequested, true);
  assert.ok(view.tickets.every((t) => t.status === "CANCELLED"));
  assert.ok(!view.tickets.some((t) => t.status === "FAILED"));
  assert.ok(!view.tickets.some((t) => t.result?.startsWith("dependency ")));
  await controller.tick("wave-op-cancel");
  assert.equal(controller.inspect("wave-op-cancel").wave.status, "CANCELLED");
});

test("operator cancel after a DONE ticket stays CANCELLED", async () => {
  const sim = createSimulator("p1-op-cancel-done");
  const controller = await seedWave(sim, "wave-op-cancel-done", ["FX-001", "FX-002", "FX-003"], CHAIN_LIMITS);
  await driveFx001ToDone(controller, "wave-op-cancel-done");
  controller.cancel("wave-op-cancel-done");
  const view = controller.inspect("wave-op-cancel-done");
  assert.equal(view.wave.status, "CANCELLED");
  assert.equal(view.wave.cancelRequested, true);
  assert.equal(view.tickets.find((t) => t.ticketId === "FX-001")?.status, "DONE");
  assert.equal(view.tickets.find((t) => t.ticketId === "FX-002")?.status, "CANCELLED");
  assert.equal(view.tickets.find((t) => t.ticketId === "FX-003")?.status, "CANCELLED");
  assert.ok(!view.tickets.some((t) => t.status === "FAILED"));
  assert.ok(!view.tickets.some((t) => t.result?.startsWith("dependency ")));
  await controller.tick("wave-op-cancel-done");
  assert.equal(controller.inspect("wave-op-cancel-done").wave.status, "CANCELLED");
});
