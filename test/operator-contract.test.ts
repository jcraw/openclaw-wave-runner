import assert from "node:assert/strict";
import test from "node:test";

import { operatorLoopDecision } from "../src/core/operator-loop.js";
import { DEFAULT_LIMITS } from "../src/domain/types.js";
import { createSimulator, seedWave } from "../src/sim/simulator.js";

test("operatorLoopDecision: agent-gate stays; human hold stops", () => {
  assert.equal(operatorLoopDecision("RUNNING"), "tick");
  assert.equal(operatorLoopDecision("AWAITING_PLAN_GATE"), "wait_plan_gate");
  assert.equal(operatorLoopDecision("WAITING_APPROVAL"), "stop_human");
  assert.equal(operatorLoopDecision("COMPLETED"), "stop_terminal");
  assert.equal(operatorLoopDecision("PAUSED"), "stop_paused");
});

test("A1/A5 agent-gate emits plan_gate_wake receipt", async () => {
  const sim = createSimulator("op-agent-gate");
  const controller = await seedWave(sim, "wave-agent", ["FX-001"], {
    maxTokens: 80_000,
    maxLaunches: 8,
  });
  await controller.start("wave-agent");
  await controller.runUntilIdle("wave-agent");
  const view = controller.inspect("wave-agent");
  assert.equal(view.wave.status, "AWAITING_PLAN_GATE");
  const ticket = view.tickets[0]!;
  assert.equal(ticket.status, "PLAN_REVIEW");
  const wakes = view.events.filter((e) => e.type === "plan_gate_wake");
  assert.equal(wakes.length, 1);
  const payload = JSON.parse(wakes[0]!.payloadJson) as {
    ticketId: string;
    revision: number;
    planPath?: string;
  };
  assert.equal(payload.ticketId, "FX-001");
  assert.equal(payload.revision, ticket.revision);
  assert.ok(payload.planPath);
  assert.equal(operatorLoopDecision(view.wave.status), "wait_plan_gate");
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

test("A3 approve is not a wake; second manual ticket gets a new wake", async () => {
  const sim = createSimulator("op-second");
  // Override FX-002 to manual so second hop also waits.
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
  let view = controller.inspect("wave-two");
  assert.equal(view.wave.status, "AWAITING_PLAN_GATE");
  const firstWakes = view.events.filter((e) => e.type === "plan_gate_wake").length;
  assert.equal(firstWakes, 1);
  const t1 = view.tickets.find((t) => t.ticketId === "FX-001")!;
  controller.approve("wave-two", t1.ticketId, t1.revision);
  view = controller.inspect("wave-two");
  assert.equal(view.events.filter((e) => e.type === "plan_gate_wake").length, firstWakes);
  for (let i = 0; i < 16; i += 1) {
    await controller.tick("wave-two");
    view = controller.inspect("wave-two");
    const t2 = view.tickets.find((t) => t.ticketId === "FX-002");
    if (view.wave.status === "AWAITING_PLAN_GATE" && t2?.status === "PLAN_REVIEW") break;
    if (view.wave.status === "COMPLETED") break;
  }
  view = controller.inspect("wave-two");
  const t2 = view.tickets.find((t) => t.ticketId === "FX-002")!;
  assert.equal(t2.status, "PLAN_REVIEW");
  assert.equal(view.wave.status, "AWAITING_PLAN_GATE");
  const wakes = view.events.filter((e) => e.type === "plan_gate_wake");
  assert.ok(wakes.length >= 2, `expected second wake, got ${wakes.length}`);
  const last = JSON.parse(wakes.at(-1)!.payloadJson) as { ticketId: string };
  assert.equal(last.ticketId, "FX-002");
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
