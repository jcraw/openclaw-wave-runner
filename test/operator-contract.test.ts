import assert from "node:assert/strict";
import test from "node:test";

import {
  hasLiveOutbox,
  hasLiveWork,
  hasPendingCloseout,
  nextStuckCount,
  operatorLoopDecision,
  progressFingerprint,
} from "../src/core/operator-loop.js";
import { DEFAULT_LIMITS } from "../src/domain/types.js";
import { createSimulator, seedWave } from "../src/sim/simulator.js";

test("progressFingerprint + nextStuckCount: hash, revision, stuck, plan-gate", () => {
  const view = {
    wave: { status: "RUNNING" as const },
    tickets: [{ ticketId: "FX-001", status: "APPROVED", revision: 1, result: "ok" }],
    outbox: [{ outboxId: "obx-1", state: "SETTLED" }],
    leases: [{ resourceKey: "writer:/repo:game:x", holder: "sim", ticketId: "FX-001" }],
  };
  const same = progressFingerprint(view);
  assert.equal(progressFingerprint(view), same);
  const bumped = {
    ...view,
    tickets: [{ ...view.tickets[0]!, revision: 2 }],
  };
  assert.notEqual(progressFingerprint(bumped), same);
  assert.deepEqual(nextStuckCount("", same, 0, 3, "RUNNING"), { count: 0, stuck: false });
  assert.deepEqual(nextStuckCount(same, same, 0, 3, "RUNNING"), { count: 1, stuck: false });
  assert.deepEqual(nextStuckCount(same, same, 2, 3, "RUNNING"), { count: 3, stuck: true });
  assert.deepEqual(nextStuckCount(same, same, 5, 3, "AWAITING_PLAN_GATE"), { count: 0, stuck: false });
  assert.deepEqual(nextStuckCount(same, same, 5, 0, "RUNNING"), { count: 6, stuck: false });
  const liveView = {
    ...view,
    tickets: [{ ticketId: "FX-001", status: "IMPLEMENTING", revision: 1 }],
    outbox: [{ outboxId: "obx-1", state: "LAUNCHED" }],
  };
  assert.equal(hasLiveOutbox(liveView), true);
  const liveFp = progressFingerprint(liveView);
  assert.deepEqual(nextStuckCount(liveFp, liveFp, 2, 3, "RUNNING", hasLiveOutbox(liveView)), {
    count: 0,
    stuck: false,
  });
  assert.equal(hasLiveOutbox(view), false);
  const verifying = {
    ...view,
    tickets: [{ ticketId: "FX-001", status: "VERIFYING", revision: 2, result: "" }],
    outbox: [{ outboxId: "obx-1", state: "SETTLED" }],
  };
  assert.equal(hasLiveOutbox(verifying), false);
  assert.equal(hasPendingCloseout(verifying), true);
  assert.equal(hasLiveWork(verifying), true);
  const vfp = progressFingerprint(verifying);
  assert.deepEqual(nextStuckCount(vfp, vfp, 20, 3, "RUNNING", hasLiveWork(verifying)), {
    count: 0,
    stuck: false,
  });
});

test("operatorLoopDecision: agent-gate stays; human hold stops", () => {
  assert.equal(operatorLoopDecision("RUNNING"), "tick");
  assert.equal(operatorLoopDecision("AWAITING_PLAN_GATE"), "wait_plan_gate");
  assert.equal(operatorLoopDecision("WAITING_APPROVAL"), "stop_human");
  assert.equal(operatorLoopDecision("COMPLETED"), "stop_terminal");
  assert.equal(operatorLoopDecision("PAUSED"), "stop_paused");
});

test("A1 agent PLAN auto-continues; no Astra wake", async () => {
  const sim = createSimulator("op-agent-gate");
  const controller = await seedWave(sim, "wave-agent", ["FX-001"], {
    maxTokens: 80_000,
    maxLaunches: 8,
  });
  await controller.start("wave-agent");
  await controller.runUntilIdle("wave-agent");
  const view = controller.inspect("wave-agent");
  assert.notEqual(view.wave.status, "AWAITING_PLAN_GATE");
  assert.notEqual(view.wave.status, "WAITING_APPROVAL");
  const ticket = view.tickets[0]!;
  assert.equal(ticket.status, "DONE");
  assert.equal(view.events.filter((e) => e.type === "plan_gate_wake").length, 0);
  assert.ok(view.events.some((e) => e.type === "plan_gate_auto"));
});

test("A4 human-hold uses WAITING_APPROVAL and no wake", async () => {
  const sim = createSimulator("op-human-hold");
  sim.tracker.seed({
    ticketId: "HX-001",
    title: "Human hold",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/HX-001.md",
    planClass: "manual",
    verifyCommand: "true",
    humanHold: true,
    humanHoldReason: "needs_jason",
    body: "needs jason",
  });
  const controller = await seedWave(sim, "wave-human", ["HX-001"], {
    maxTokens: 80_000,
    maxLaunches: 8,
  });
  await controller.start("wave-human");
  await controller.runUntilIdle("wave-human");
  const view = controller.inspect("wave-human");
  assert.equal(view.wave.status, "WAITING_APPROVAL");
  assert.equal(view.events.filter((e) => e.type === "plan_gate_wake").length, 0);
  assert.equal(operatorLoopDecision(view.wave.status), "stop_human");
});

test("A3 second manual ticket auto-continues; no wakes", async () => {
  const sim = createSimulator("op-second");
  sim.tracker.seed({
    ticketId: "FX-002",
    title: "Fixture two manual",
    contentHash: "",
    dependsOn: ["FX-001"],
    order: 2,
    sourcePath: "issues/FX-002.md",
    planClass: "manual",
    verifyCommand: "true",
    body: "two manual",
  });
  const controller = await seedWave(sim, "wave-two", ["FX-001", "FX-002"], {
    maxTokens: 80_000,
    maxLaunches: 12,
    perStageReservationTokens: 8_000,
  });
  await controller.start("wave-two");
  await controller.runUntilIdle("wave-two");
  const view = controller.inspect("wave-two");
  assert.equal(view.wave.status, "COMPLETED");
  assert.equal(view.tickets.find((t) => t.ticketId === "FX-001")?.status, "DONE");
  assert.equal(view.tickets.find((t) => t.ticketId === "FX-002")?.status, "DONE");
  assert.equal(view.events.filter((e) => e.type === "plan_gate_wake").length, 0);
  const autos = view.events.filter((e) => e.type === "plan_gate_auto");
  assert.ok(autos.length >= 2, `expected auto receipts, got ${autos.length}`);
});

test("safe-policy still auto-approves with no gate/wake", async () => {
  const sim = createSimulator("op-safe");
  sim.tracker.seed({
    ticketId: "SX-001",
    title: "safe",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/SX-001.md",
    planClass: "safe-policy",
    verifyCommand: "true",
    body: "safe",
  });
  const controller = await seedWave(sim, "wave-safe", ["SX-001"], {
    ...DEFAULT_LIMITS,
    maxTokens: 80_000,
    maxLaunches: 8,
  });
  await controller.start("wave-safe");
  await controller.runUntilIdle("wave-safe");
  const view = controller.inspect("wave-safe");
  assert.notEqual(view.wave.status, "AWAITING_PLAN_GATE");
  assert.notEqual(view.wave.status, "WAITING_APPROVAL");
  assert.equal(view.events.filter((e) => e.type === "plan_gate_wake").length, 0);
});
