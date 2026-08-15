import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { eligibleForBoundedWave, GAME_JAM } from "../src/adapters/studio.js";
import { admitReservation, applySettlement } from "../src/core/budget.js";
import { WaveDatabase } from "../src/store/database.js";
import { DEFAULT_LIMITS, type BudgetEntry, type WaveRecord } from "../src/domain/types.js";
import { createSimulator, seedWave } from "../src/sim/simulator.js";

function emptyCounters(startedAt = 1_000) {
  return {
    committedTokens: 0,
    reservedTokens: 0,
    indeterminateTokens: 0,
    committedCostMicros: 0,
    reservedCostMicros: 0,
    indeterminateCostMicros: 0,
    launches: 0,
    startedAt,
  };
}

function sampleWave(over: Partial<WaveRecord> = {}): WaveRecord {
  return {
    waveId: "wave-matrix",
    manifestJson: "{}",
    manifestHash: "abc",
    repoPath: "/tmp/wave-fixture-repo",
    baseSha: "base",
    status: "RUNNING",
    revision: 1,
    limits: DEFAULT_LIMITS,
    counters: emptyCounters(),
    owner: "controller",
    nextAction: "tick",
    createdAt: 1_000,
    updatedAt: 1_000,
    cancelRequested: false,
    quotaMode: "tokens",
    ...over,
  };
}

function reserved(tokens = 8_000): BudgetEntry {
  return {
    budgetId: "b1",
    waveId: "wave-matrix",
    state: "RESERVED",
    tokensReserved: tokens,
    costReservedMicros: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
  };
}

test("matrix: stop_at and wall deadline refuse admission atomically", () => {
  assert.throws(
    () =>
      admitReservation({
        wave: sampleWave({ stopAt: 2_000 }),
        entries: [],
        candidateTokens: 100,
        candidateCostMicros: 0,
        now: 2_000,
        extraLaunch: true,
      }),
    /stop_at/,
  );
  assert.throws(
    () =>
      admitReservation({
        wave: sampleWave({ deadlineMs: 500, counters: emptyCounters(1_000) }),
        entries: [],
        candidateTokens: 100,
        candidateCostMicros: 0,
        now: 1_600,
        extraLaunch: true,
      }),
    /deadline/,
  );
});

test("matrix: legacy manifest max wall does not stop long-running supervised work", () => {
  assert.doesNotThrow(() =>
    admitReservation({
      wave: sampleWave({
        limits: { ...DEFAULT_LIMITS, maxWallTimeMs: 100 },
        counters: emptyCounters(1_000),
      }),
      entries: [],
      candidateTokens: 100,
      candidateCostMicros: 0,
      now: 8 * 60 * 60_000 + 1_000,
      extraLaunch: true,
    }),
  );
});

test("matrix: missing usage settlement stays INDETERMINATE at full reservation", () => {
  const next = applySettlement(reserved(8_000), undefined, undefined, 2_000);
  assert.equal(next.state, "INDETERMINATE");
  assert.equal(next.tokensReserved, 8_000);
  assert.equal(next.tokensActual, undefined);
});

test("matrix: malformed or implicit tickets are not eligible", () => {
  const missing = eligibleForBoundedWave("---\nid: GJ-1\nstatus: open\n---\n", GAME_JAM);
  assert.equal(missing.eligible, false);
  assert.match(missing.reason, /malformed|implicit/);

  const garbage = eligibleForBoundedWave(
    "---\nid: GJ-1\nstatus: open\nagent_eligible: maybe\n---\n",
    GAME_JAM,
  );
  assert.equal(garbage.eligible, false);

  const explicit = eligibleForBoundedWave(
    "---\nid: GJ-1\nstatus: open\nagent_eligible: true\n---\n",
    GAME_JAM,
  );
  assert.equal(explicit.eligible, true);

  const aliasOff = eligibleForBoundedWave(
    "---\nid: GJ-1\nstate: open\neligible: false\n---\n",
    GAME_JAM,
  );
  assert.equal(aliasOff.eligible, false);

  const aliasOn = eligibleForBoundedWave(
    "---\nid: GJ-1\nstate: open\neligible: true\n---\n",
    GAME_JAM,
  );
  assert.equal(aliasOn.eligible, true);

  const terminalState = eligibleForBoundedWave(
    "---\nid: GJ-1\nstate: done\neligible: true\n---\n",
    GAME_JAM,
  );
  assert.equal(terminalState.eligible, false);
  assert.equal(terminalState.reason, "terminal");
});

test("matrix: projection failure does not roll back durable wave state", async () => {
  const sim = createSimulator("proj-fail");
  const controller = await seedWave(sim, "wave-proj-fail", ["FX-001"]);
  sim.tracker.mirror = async () => {
    throw new Error("board down");
  };
  await controller.start("wave-proj-fail");
  await controller.runUntilIdle("wave-proj-fail");
  const view = controller.inspect("wave-proj-fail");
  assert.notEqual(view.wave.status, "DRAFT");
  assert.ok(view.outbox.length >= 1);
  assert.equal(sim.tracker.mirrors.length, 0);
});

test("matrix: sqlite two-handle write survives busy_timeout", () => {
  const dir = mkdtempSync(join(tmpdir(), "wave-busy-"));
  const path = join(dir, "wave.sqlite");
  const a = new WaveDatabase(path);
  const b = new WaveDatabase(path);
  a.db.exec("CREATE TABLE IF NOT EXISTS probe (id TEXT PRIMARY KEY, n INTEGER);");
  a.db.exec("INSERT INTO probe (id, n) VALUES ('x', 1);");
  b.db.exec("UPDATE probe SET n = 2 WHERE id = 'x';");
  const row = a.db.prepare("SELECT n FROM probe WHERE id = 'x'").get() as { n: number };
  assert.equal(row.n, 2);
  a.close();
  b.close();
});

test("matrix: failed worker cannot bypass retry or launch caps", async () => {
  const sim = createSimulator("retry-cap");
  sim.worker.failNext = true;
  const controller = await seedWave(sim, "wave-retry", ["FX-001"], {
    maxLaunches: 1,
    maxRetriesPerStage: 0,
    maxTokens: 16_000,
    perStageReservationTokens: 8_000,
  });
  try {
    await controller.start("wave-retry");
    await controller.runUntilIdle("wave-retry");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /Admission denied|max_retries|max_launches|token ceiling|FAILED|cancelled/);
  }
  const view = controller.inspect("wave-retry");
  assert.ok(sim.worker.launches <= 1, `launches=${sim.worker.launches}`);
  assert.equal(view.wave.counters.launches, sim.worker.launches);
  const before = sim.worker.launches;
  try {
    await controller.tick("wave-retry");
  } catch {
    // sticky fail / admission deny is acceptable; extra launch is not
  }
  assert.equal(sim.worker.launches, before, "retry must not emit another launch");
  const ticket = view.tickets[0];
  assert.ok(ticket);
  assert.ok(
    ticket.status === "FAILED" ||
      view.wave.status === "FAILED" ||
      view.wave.status === "BUDGET_STOPPED" ||
      view.outbox.some((item) => item.state === "FAILED" || item.state === "SETTLED"),
    `unexpected status ticket=${ticket.status} wave=${view.wave.status}`,
  );
});

