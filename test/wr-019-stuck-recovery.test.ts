import assert from "node:assert/strict";
import test from "node:test";

import { WAVE_OWNERS, WAVE_NEXT } from "../src/core/state-machine.js";
import { writerLeaseKey } from "../src/domain/writer-scope.js";
import { DEFAULT_LIMITS, type FrozenTicket } from "../src/domain/types.js";
import { createSimulator, seedWave } from "../src/sim/simulator.js";

const SCOPE = "game:rink_rush";
const REPO = "/tmp/wave-fixture-repo";
const LIMITS = {
  ...DEFAULT_LIMITS,
  maxTokens: 80_000,
  maxLaunches: 10,
  maxRetriesPerStage: 0,
  perStageReservationTokens: 8_000,
};

function pair(overA: Partial<FrozenTicket> = {}, overB: Partial<FrozenTicket> = {}): {
  a: FrozenTicket & { body: string };
  b: FrozenTicket & { body: string };
} {
  return {
    a: {
      ticketId: "FX-001",
      title: "one",
      contentHash: "",
      dependsOn: [],
      order: 1,
      sourcePath: "issues/rink_rush/FX-001.md",
      planClass: "safe-policy",
      verifyCommand: "true",
      writerScope: SCOPE,
      body: "one",
      ...overA,
    },
    b: {
      ticketId: "FX-002",
      title: "two",
      contentHash: "",
      dependsOn: [],
      order: 2,
      sourcePath: "issues/rink_rush/FX-002.md",
      planClass: "safe-policy",
      verifyCommand: "true",
      writerScope: SCOPE,
      body: "two",
      ...overB,
    },
  };
}

function seedPair(
  sim: ReturnType<typeof createSimulator>,
  overA: Partial<FrozenTicket> = {},
  overB: Partial<FrozenTicket> = {},
): void {
  const { a, b } = pair(overA, overB);
  sim.tracker.seed(a);
  sim.tracker.seed(b);
}

function completeRunningPlans(sim: ReturnType<typeof createSimulator>): void {
  for (const [key, row] of sim.worker.byKey) {
    if (key.includes(":PLAN:") && row.status === "running") row.status = "succeeded";
  }
}

async function driveToImplLaunched(
  sim: ReturnType<typeof createSimulator>,
  controller: Awaited<ReturnType<typeof seedWave>>,
  waveId: string,
): Promise<string> {
  sim.worker.completeOnInspect = false;
  await controller.start(waveId);
  for (let i = 0; i < 16; i += 1) {
    completeRunningPlans(sim);
    await controller.tick(waveId);
    const view = controller.inspect(waveId);
    const impl = view.outbox.find((item) => item.stage === "IMPL" && item.state === "LAUNCHED");
    if (impl) return impl.idempotencyKey;
  }
  throw new Error("IMPL never launched");
}

test("lease-on-fail: A verify-fail releases lease; B IMPLs without clock wait", async () => {
  const sim = createSimulator("wr019-lease-fail");
  seedPair(sim, { verifyCommand: "false" });
  const controller = await seedWave(sim, "wave-lease-fail", ["FX-001", "FX-002"], LIMITS);
  const t0 = sim.clock.now();
  await controller.start("wave-lease-fail");
  await controller.runUntilIdle("wave-lease-fail");
  assert.equal(sim.clock.now(), t0);
  const view = controller.inspect("wave-lease-fail");
  const a = view.tickets.find((t) => t.ticketId === "FX-001");
  const b = view.tickets.find((t) => t.ticketId === "FX-002");
  assert.equal(a?.status, "FAILED");
  assert.ok(!view.leases.some((l) => l.ticketId === "FX-001"));
  assert.equal(b?.status, "DONE");
  assert.ok(view.wave.status === "FAILED" || view.wave.status === "COMPLETED");
});

test("retry keeps lease: empty IMPL death re-arms A; B does not take IMPL", async () => {
  const sim = createSimulator("wr019-retry-lease");
  seedPair(sim);
  const controller = await seedWave(sim, "wave-retry", ["FX-001", "FX-002"], {
    ...LIMITS,
    maxRetriesPerStage: 1,
  });
  const key = await driveToImplLaunched(sim, controller, "wave-retry");
  const row = sim.worker.byKey.get(key);
  assert.ok(row);
  row.status = "cancelled";
  row.output = undefined;
  await controller.tick("wave-retry");
  const view = controller.inspect("wave-retry");
  const a = view.tickets.find((t) => t.ticketId === "FX-001");
  const b = view.tickets.find((t) => t.ticketId === "FX-002");
  assert.ok(a?.status === "APPROVED" || a?.status === "IMPLEMENTING");
  assert.match(a?.result ?? "", /retry 2 after/i);
  assert.ok(view.leases.some((l) => l.ticketId === "FX-001"));
  assert.notEqual(b?.status, "IMPLEMENTING");
  assert.notEqual(b?.status, "DONE");
});

test("cancel releases writer lease", async () => {
  const sim = createSimulator("wr019-cancel");
  seedPair(sim);
  const controller = await seedWave(sim, "wave-cancel", ["FX-001"], LIMITS);
  await driveToImplLaunched(sim, controller, "wave-cancel");
  assert.ok(controller.inspect("wave-cancel").leases.length > 0);
  controller.cancel("wave-cancel");
  assert.equal(controller.inspect("wave-cancel").leases.length, 0);
});

test("emergency-stop releases live IMPL lease", async () => {
  const sim = createSimulator("wr019-estop");
  seedPair(sim);
  const controller = await seedWave(sim, "wave-estop", ["FX-001"], LIMITS);
  await driveToImplLaunched(sim, controller, "wave-estop");
  assert.ok(controller.inspect("wave-estop").leases.length > 0);
  controller.emergencyStop("test");
  assert.equal(controller.inspect("wave-estop").leases.length, 0);
});

test("wave FAILED when both tickets fail", async () => {
  const sim = createSimulator("wr019-wave-fail");
  seedPair(sim, { verifyCommand: "false" }, { verifyCommand: "false" });
  const controller = await seedWave(sim, "wave-both-fail", ["FX-001", "FX-002"], LIMITS);
  await controller.start("wave-both-fail");
  await controller.runUntilIdle("wave-both-fail");
  const view = controller.inspect("wave-both-fail");
  assert.equal(view.wave.status, "FAILED");
  assert.ok(view.tickets.every((t) => t.status === "FAILED"));
});

test("wave COMPLETED when both tickets DONE", async () => {
  const sim = createSimulator("wr019-wave-ok");
  seedPair(sim);
  const controller = await seedWave(sim, "wave-both-ok", ["FX-001", "FX-002"], LIMITS);
  await controller.start("wave-both-ok");
  await controller.runUntilIdle("wave-both-ok");
  const view = controller.inspect("wave-both-ok");
  assert.equal(view.wave.status, "COMPLETED");
  assert.equal(view.tickets.filter((t) => t.status === "DONE").length, 2);
});

test("unlaunchable belt: orphan lease held by FAILED A is freed; B not stuck", async () => {
  const sim = createSimulator("wr019-orphan");
  seedPair(sim);
  const controller = await seedWave(sim, "wave-orphan", ["FX-001", "FX-002"], LIMITS);
  controller.freeze("wave-orphan");
  const wave = controller.db.getWave("wave-orphan")!;
  wave.status = "RUNNING";
  wave.owner = WAVE_OWNERS.RUNNING;
  wave.nextAction = WAVE_NEXT.RUNNING;
  controller.db.putWave(wave);
  const a = controller.db.getTicket("wave-orphan", "FX-001")!;
  a.status = "FAILED";
  a.result = "injected";
  controller.db.putTicket(a);
  const b = controller.db.getTicket("wave-orphan", "FX-002")!;
  b.status = "APPROVED";
  controller.db.putTicket(b);
  controller.db.putLease({
    resourceKey: writerLeaseKey(REPO, SCOPE),
    generation: 1,
    holder: "sim",
    processIdentity: "sim-1",
    expiresAt: sim.clock.now() + 60_000,
    createdAt: sim.clock.now(),
    waveId: "wave-orphan",
    ticketId: "FX-001",
  });
  await controller.tick("wave-orphan");
  const view = controller.inspect("wave-orphan");
  const bAfter = view.tickets.find((t) => t.ticketId === "FX-002");
  assert.ok(!view.leases.some((l) => l.ticketId === "FX-001"));
  assert.ok(
    bAfter?.status === "IMPLEMENTING" ||
      bAfter?.status === "VERIFYING" ||
      bAfter?.status === "DONE" ||
      bAfter?.status === "FAILED",
    `B stuck at ${bAfter?.status}`,
  );
  assert.notEqual(bAfter?.result, "unlaunchable: no progress");
});

test("foreign lease wait: B stays APPROVED this tick", async () => {
  const sim = createSimulator("wr019-foreign");
  seedPair(sim);
  const controller = await seedWave(sim, "wave-foreign", ["FX-002"], LIMITS);
  controller.db.putLease({
    resourceKey: writerLeaseKey(REPO, SCOPE),
    generation: 1,
    holder: "other",
    processIdentity: "other-1",
    expiresAt: sim.clock.now() + 60_000,
    createdAt: sim.clock.now(),
    waveId: "other-wave",
    ticketId: "OTHER-1",
  });
  await controller.start("wave-foreign");
  await controller.runUntilIdle("wave-foreign");
  const view = controller.inspect("wave-foreign");
  const b = view.tickets.find((t) => t.ticketId === "FX-002");
  assert.equal(b?.status, "APPROVED");
  assert.equal(view.wave.status, "RUNNING");
  assert.notEqual(b?.result, "unlaunchable: no progress");
});

test("admit reject: dry-run + create omit verify and list ids", async () => {
  const sim = createSimulator("wr019-admit-bad");
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
  const controller = sim.open();
  const input = {
    waveId: "wave-admit-bad",
    repoPath: REPO,
    ticketIds: ["FX-001"],
    limits: LIMITS,
  };
  await assert.rejects(() => controller.dryRun(input), /missing_verify: FX-001/);
  await assert.rejects(() => controller.create(input), /missing_verify: FX-001/);
});

test("admit ok: explicit true; warnings do not fail create", async () => {
  const sim = createSimulator("wr019-admit-ok");
  seedPair(sim, { humanHold: true, humanHoldReason: "needs_jason" });
  const controller = sim.open();
  const preview = await controller.dryRun({
    waveId: "wave-admit-ok",
    repoPath: REPO,
    ticketIds: ["FX-001", "FX-002"],
    limits: LIMITS,
  });
  assert.equal(preview.ok, true);
  assert.ok(preview.admitBlockers.some((b) => b.code === "human_hold" && b.ticketId === "FX-001"));
  assert.ok(preview.admitBlockers.some((b) => b.code === "shared_writer_scope"));
  assert.ok(!preview.admitBlockers.some((b) => b.code === "missing_verify"));
  const created = await controller.create({
    waveId: "wave-admit-ok",
    repoPath: REPO,
    ticketIds: ["FX-001", "FX-002"],
    limits: LIMITS,
  });
  assert.equal(created.tickets.length, 2);
});

test("inspect reason: controller flip after worker succeeded", async () => {
  const sim = createSimulator("wr019-inspect");
  seedPair(sim, { verifyCommand: "false" });
  const controller = await seedWave(sim, "wave-inspect", ["FX-001"], LIMITS);
  await controller.start("wave-inspect");
  await controller.runUntilIdle("wave-inspect");
  const view = controller.inspect("wave-inspect");
  const ticket = view.tickets[0];
  assert.equal(ticket?.status, "FAILED");
  assert.match(ticket?.result ?? "", /controller failed \(worker succeeded\):/);
  assert.ok(view.artifacts.some((a) => a.kind === "settle-reason"));
});
