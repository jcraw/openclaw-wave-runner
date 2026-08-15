import assert from "node:assert/strict";
import test from "node:test";

import {
  admitReservation,
  applySettlement,
  assertBudgetStatesForTerminal,
  countersFromBudgets,
  failClosedWithoutRates,
  markIndeterminate,
  releaseIfUnused,
  reservationCeiling,
  summarizeBudgets,
} from "../src/core/budget.js";
import { acquireLease, canAcquire, isLeaseStale, releaseLease } from "../src/core/lease.js";
import { SafetyGateError, WaveError } from "../src/domain/errors.js";
import {
  SAFETY,
  assertBoundedWaveRequest,
  assertSupervisedBoundedLaunch,
} from "../src/domain/safety.js";
import {
  DEFAULT_LIMITS,
  type BudgetEntry,
  type LeaseRecord,
  type WaveLimits,
  type WaveRecord,
} from "../src/domain/types.js";

function entry(state: BudgetEntry["state"], extra: Partial<BudgetEntry> = {}): BudgetEntry {
  return {
    budgetId: "b",
    waveId: "w",
    state,
    tokensReserved: 8_000,
    costReservedMicros: 0,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

function lease(over: Partial<LeaseRecord> = {}): LeaseRecord {
  return {
    resourceKey: "repo-writer:/tmp/r",
    generation: 2,
    holder: "sim",
    processIdentity: "sim-1",
    pid: 7,
    pidStartTime: "start-a",
    expiresAt: 10_000,
    createdAt: 1,
    ...over,
  };
}

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

function limits(over: Partial<WaveLimits> = {}): WaveLimits {
  return { ...DEFAULT_LIMITS, ...over };
}

function sampleWave(over: Partial<WaveRecord> = {}): WaveRecord {
  return {
    waveId: "wave-mutation",
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

function admit(over: {
  wave?: WaveRecord;
  entries?: BudgetEntry[];
  candidateTokens?: number;
  candidateCostMicros?: number;
  now?: number;
  extraLaunch?: boolean;
} = {}): void {
  admitReservation({
    wave: over.wave ?? sampleWave(),
    entries: over.entries ?? [],
    candidateTokens: over.candidateTokens ?? 1,
    candidateCostMicros: over.candidateCostMicros ?? 0,
    now: over.now ?? 1_000,
    extraLaunch: over.extraLaunch,
  });
}

test("mutation: releaseIfUnused only releases RESERVED rows", () => {
  const released = releaseIfUnused(entry("RESERVED"), 9);
  assert.equal(released.state, "RELEASED");
  assert.equal(released.tokensActual, 0);
  assert.equal(released.costActualMicros, 0);
  assert.equal(released.updatedAt, 9);
  assert.equal(releaseIfUnused(entry("COMMITTED"), 9).state, "COMMITTED");
  assert.equal(releaseIfUnused(entry("INDETERMINATE"), 9).state, "INDETERMINATE");
  const alreadyReleased = entry("RELEASED", { tokensActual: 4, costActualMicros: 5, updatedAt: 1 });
  const noop = releaseIfUnused(alreadyReleased, 9);
  assert.equal(noop.state, "RELEASED");
  assert.equal(noop.tokensActual, 4);
  assert.equal(noop.costActualMicros, 5);
  assert.equal(noop.updatedAt, 1);
});

test("mutation: markIndeterminate does not reopen settled rows", () => {
  assert.equal(markIndeterminate(entry("RESERVED"), 3).state, "INDETERMINATE");
  assert.equal(markIndeterminate(entry("COMMITTED"), 3).state, "COMMITTED");
  assert.equal(markIndeterminate(entry("RELEASED"), 3).state, "RELEASED");
});

test("mutation: applySettlement commits only when actual tokens exist", () => {
  const committed = applySettlement(entry("RESERVED"), 12, 4, 8);
  assert.equal(committed.state, "COMMITTED");
  assert.equal(committed.tokensActual, 12);
  assert.equal(committed.costActualMicros, 4);
  assert.equal(applySettlement(entry("COMMITTED"), 1, 1, 8).state, "COMMITTED");
  assert.equal(applySettlement(entry("RELEASED"), 1, 1, 8).state, "RELEASED");
});

test("mutation: terminal budgets reject leftover RESERVED", () => {
  assert.doesNotThrow(() => assertBudgetStatesForTerminal([]));
  assert.doesNotThrow(() =>
    assertBudgetStatesForTerminal([entry("COMMITTED"), entry("INDETERMINATE"), entry("RELEASED")]),
  );
  assert.throws(() => assertBudgetStatesForTerminal([entry("RESERVED")]), WaveError);
});

test("mutation: canAcquire / acquire / stale / release fencing", () => {
  assert.equal(canAcquire(undefined, 5, { holder: "a", processIdentity: "a-1" }), "acquire");
  assert.equal(
    canAcquire(lease({ holder: "a", processIdentity: "a-1" }), 5, {
      holder: "a",
      processIdentity: "a-1",
    }),
    "hold",
  );
  assert.equal(
    canAcquire(lease({ holder: "a", processIdentity: "a-1", expiresAt: 4 }), 5, {
      holder: "b",
      processIdentity: "b-1",
    }),
    "acquire",
  );
  assert.equal(
    canAcquire(lease({ holder: "a", processIdentity: "a-1", expiresAt: 9 }), 5, {
      holder: "b",
      processIdentity: "b-1",
    }),
    "deny",
  );

  assert.throws(
    () =>
      acquireLease({
        current: lease(),
        resourceKey: "repo-writer:/tmp/r",
        now: 5,
        ttlMs: 100,
        claimant: { holder: "other", processIdentity: "other-1" },
      }),
    /held/,
  );

  const held = acquireLease({
    current: lease({ holder: "sim", processIdentity: "sim-1" }),
    resourceKey: "repo-writer:/tmp/r",
    now: 5,
    ttlMs: 100,
    claimant: { holder: "sim", processIdentity: "sim-1" },
  });
  assert.equal(held.generation, 2);
  assert.equal(held.createdAt, 1);
  assert.equal(held.expiresAt, 105);

  const next = acquireLease({
    current: lease({ expiresAt: 1, createdAt: 42 }),
    resourceKey: "repo-writer:/tmp/r",
    now: 5,
    ttlMs: 100,
    claimant: { holder: "b", processIdentity: "b-1" },
  });
  assert.equal(next.generation, 3);
  assert.equal(next.createdAt, 42);

  assert.equal(isLeaseStale(lease({ expiresAt: 5 }), 5), true);
  assert.equal(isLeaseStale(lease({ expiresAt: 6 }), 5), false);

  assert.throws(
    () =>
      releaseLease({
        current: lease(),
        claimant: { holder: "sim", processIdentity: "sim-1", pid: 7, pidStartTime: "start-a" },
        expectedGeneration: 1,
        now: 5,
      }),
    /Stale lease generation/,
  );
  assert.throws(
    () =>
      releaseLease({
        current: lease(),
        claimant: { holder: "other", processIdentity: "sim-1", pid: 7, pidStartTime: "start-a" },
        expectedGeneration: 2,
        now: 5,
      }),
    /holder/,
  );
  assert.throws(
    () =>
      releaseLease({
        current: lease(),
        claimant: { holder: "sim", processIdentity: "other", pid: 7, pidStartTime: "start-a" },
        expectedGeneration: 2,
        now: 5,
      }),
    /PID reuse|identity/,
  );
  assert.doesNotThrow(() =>
    releaseLease({
      current: lease(),
      claimant: { holder: "sim", processIdentity: "sim-1", pid: 7, pidStartTime: "start-a" },
      expectedGeneration: 2,
      now: 5,
    }),
  );
});

test("mutation: summarizeBudgets mixed-bag snapshot and empty list", () => {
  const committed = entry("COMMITTED", {
    tokensReserved: 100,
    tokensActual: 7,
    costReservedMicros: 50,
    costActualMicros: 3,
  });
  const reserved = entry("RESERVED", {
    tokensReserved: 11,
    costReservedMicros: 13,
    tokensActual: 999,
    costActualMicros: 999,
  });
  const indeterminate = entry("INDETERMINATE", {
    tokensReserved: 17,
    costReservedMicros: 19,
    tokensActual: 888,
    costActualMicros: 888,
  });
  const released = entry("RELEASED", {
    tokensReserved: 1_000,
    costReservedMicros: 2_000,
    tokensActual: 3_000,
    costActualMicros: 4_000,
  });

  const snap = summarizeBudgets([committed, reserved, indeterminate, released]);
  assert.equal(snap.committedTokens, 7);
  assert.equal(snap.committedCostMicros, 3);
  assert.equal(snap.reservedTokens, 11);
  assert.equal(snap.reservedCostMicros, 13);
  assert.equal(snap.indeterminateTokens, 17);
  assert.equal(snap.indeterminateCostMicros, 19);

  const omitted = summarizeBudgets([
    entry("COMMITTED", { tokensReserved: 100, costReservedMicros: 50 }),
  ]);
  assert.equal(omitted.committedTokens, 0);
  assert.equal(omitted.committedCostMicros, 0);

  const onlyReserved = summarizeBudgets([
    entry("RESERVED", { tokensReserved: 21, costReservedMicros: 22, tokensActual: 1, costActualMicros: 2 }),
  ]);
  assert.equal(onlyReserved.reservedTokens, 21);
  assert.equal(onlyReserved.reservedCostMicros, 22);
  assert.equal(onlyReserved.committedTokens, 0);
  assert.equal(onlyReserved.indeterminateTokens, 0);

  const onlyIndeterminate = summarizeBudgets([
    entry("INDETERMINATE", {
      tokensReserved: 31,
      costReservedMicros: 32,
      tokensActual: 1,
      costActualMicros: 2,
    }),
  ]);
  assert.equal(onlyIndeterminate.indeterminateTokens, 31);
  assert.equal(onlyIndeterminate.indeterminateCostMicros, 32);
  assert.equal(onlyIndeterminate.committedTokens, 0);
  assert.equal(onlyIndeterminate.reservedTokens, 0);

  const onlyReleased = summarizeBudgets([released]);
  assert.equal(onlyReleased.committedTokens, 0);
  assert.equal(onlyReleased.reservedTokens, 0);
  assert.equal(onlyReleased.indeterminateTokens, 0);
  assert.equal(onlyReleased.committedCostMicros, 0);
  assert.equal(onlyReleased.reservedCostMicros, 0);
  assert.equal(onlyReleased.indeterminateCostMicros, 0);

  const empty = summarizeBudgets([]);
  assert.deepEqual(empty, {
    committedTokens: 0,
    reservedTokens: 0,
    indeterminateTokens: 0,
    committedCostMicros: 0,
    reservedCostMicros: 0,
    indeterminateCostMicros: 0,
  });
});

test("mutation: countersFromBudgets copies snapshot and uses launches/startedAt args", () => {
  const counters = countersFromBudgets([], 4);
  assert.equal(counters.launches, 4);
  assert.equal(counters.committedTokens, 0);
  assert.equal(counters.reservedTokens, 0);
  assert.equal(counters.indeterminateTokens, 0);
  assert.equal(counters.committedCostMicros, 0);
  assert.equal(counters.reservedCostMicros, 0);
  assert.equal(counters.indeterminateCostMicros, 0);
  assert.equal("startedAt" in counters, false);
  assert.equal(counters.startedAt, undefined);

  const withZeroStart = countersFromBudgets([], 0, 0);
  assert.equal(withZeroStart.startedAt, 0);
  assert.equal(withZeroStart.launches, 0);

  const mixed = countersFromBudgets(
    [
      entry("COMMITTED", {
        tokensReserved: 100,
        tokensActual: 7,
        costReservedMicros: 50,
        costActualMicros: 3,
      }),
      entry("RESERVED", { tokensReserved: 11, costReservedMicros: 13 }),
      entry("INDETERMINATE", { tokensReserved: 17, costReservedMicros: 19 }),
      entry("RELEASED", { tokensReserved: 1_000, costReservedMicros: 2_000, tokensActual: 3_000 }),
    ],
    2,
    99,
  );
  assert.equal(mixed.committedTokens, 7);
  assert.equal(mixed.committedCostMicros, 3);
  assert.equal(mixed.reservedTokens, 11);
  assert.equal(mixed.reservedCostMicros, 13);
  assert.equal(mixed.indeterminateTokens, 17);
  assert.equal(mixed.indeterminateCostMicros, 19);
  assert.equal(mixed.launches, 2);
  assert.equal(mixed.startedAt, 99);
});

test("mutation: admitReservation sticky cancel is fail-closed", () => {
  assert.throws(
    () => admit({ wave: sampleWave({ cancelRequested: true }) }),
    /cancellation is sticky/,
  );
  assert.doesNotThrow(() => admit({ wave: sampleWave({ cancelRequested: false }) }));
});

test("mutation: admitReservation equality bounds on stop/deadline/wall/launches", () => {
  assert.throws(
    () => admit({ wave: sampleWave({ stopAt: 2_000 }), now: 2_000 }),
    /stop_at/,
  );
  assert.doesNotThrow(() => admit({ wave: sampleWave({ stopAt: 2_000 }), now: 1_999 }));

  assert.throws(
    () =>
      admit({
        wave: sampleWave({ deadlineMs: 500, counters: emptyCounters(1_000) }),
        now: 1_500,
      }),
    /deadline/,
  );
  assert.doesNotThrow(() =>
    admit({
      wave: sampleWave({ deadlineMs: 500, counters: emptyCounters(1_000) }),
      now: 1_499,
    }),
  );

  assert.doesNotThrow(() =>
    admit({
      wave: sampleWave({
        limits: limits({ maxWallTimeMs: 100 }),
        counters: emptyCounters(1_000),
      }),
      now: 8 * 60 * 60_000 + 1_000,
    }),
  );
  assert.throws(
    () =>
      admit({
        wave: sampleWave({
          deadlineMs: 100,
          counters: emptyCounters(1_000),
        }),
        now: 1_100,
      }),
    /deadline/,
  );

  assert.throws(
    () =>
      admit({
        wave: sampleWave({
          limits: limits({ maxLaunches: 4 }),
          counters: { ...emptyCounters(), launches: 4 },
        }),
        extraLaunch: true,
      }),
    /max_launches/,
  );
  assert.doesNotThrow(() =>
    admit({
      wave: sampleWave({
        limits: limits({ maxLaunches: 4 }),
        counters: { ...emptyCounters(), launches: 3 },
      }),
      extraLaunch: true,
    }),
  );
  assert.doesNotThrow(() =>
    admit({
      wave: sampleWave({
        limits: limits({ maxLaunches: 4 }),
        counters: { ...emptyCounters(), launches: 4 },
      }),
      extraLaunch: false,
    }),
  );
  assert.doesNotThrow(() =>
    admit({
      wave: sampleWave({
        limits: limits({ maxLaunches: 4 }),
        counters: { ...emptyCounters(), launches: 4 },
      }),
    }),
  );
});

test("mutation: admitReservation token sum includes committed+reserved+indeterminate+candidate", () => {
  const entries = [
    entry("COMMITTED", { tokensActual: 10, costActualMicros: 0 }),
    entry("RESERVED", { tokensReserved: 20, costReservedMicros: 0 }),
    entry("INDETERMINATE", { tokensReserved: 30, costReservedMicros: 0 }),
    entry("RELEASED", { tokensReserved: 1_000, tokensActual: 1_000, costReservedMicros: 0 }),
  ];
  assert.throws(
    () =>
      admit({
        wave: sampleWave({ limits: limits({ maxTokens: 64 }) }),
        entries,
        candidateTokens: 5,
      }),
    /token ceiling/,
  );
  assert.doesNotThrow(() =>
    admit({
      wave: sampleWave({ limits: limits({ maxTokens: 65 }) }),
      entries,
      candidateTokens: 5,
    }),
  );
  assert.doesNotThrow(() =>
    admit({
      wave: sampleWave({ limits: limits({ maxTokens: 65 }) }),
      entries,
      candidateTokens: 5,
    }),
  );
  assert.throws(
    () =>
      admit({
        wave: sampleWave({ limits: limits({ maxTokens: 1 }) }),
        entries: [],
        candidateTokens: 2,
      }),
    /token ceiling/,
  );
  assert.doesNotThrow(() =>
    admit({
      wave: sampleWave({ limits: limits({ maxTokens: 1 }) }),
      entries: [],
      candidateTokens: 1,
    }),
  );
});

test("mutation: admitReservation USD/cost ceiling matrix", () => {
  const overCost = [
    entry("COMMITTED", { tokensActual: 0, costActualMicros: 4 }),
    entry("RESERVED", { tokensReserved: 0, costReservedMicros: 5 }),
    entry("INDETERMINATE", { tokensReserved: 0, costReservedMicros: 6 }),
    entry("RELEASED", { costReservedMicros: 9_000, costActualMicros: 9_000 }),
  ];

  assert.throws(
    () =>
      admit({
        wave: sampleWave({
          quotaMode: "usd",
          limits: limits({ maxCostMicros: 10 }),
        }),
        entries: [],
        candidateCostMicros: 11,
      }),
    /cost ceiling/,
  );
  assert.throws(
    () =>
      admit({
        wave: sampleWave({
          quotaMode: "usd",
          limits: limits({ maxCostMicros: 0 }),
        }),
        entries: [],
        candidateCostMicros: 1,
      }),
    /cost ceiling/,
  );
  assert.doesNotThrow(() =>
    admit({
      wave: sampleWave({
        quotaMode: "usd",
        limits: limits({ maxCostMicros: 10 }),
      }),
      entries: [],
      candidateCostMicros: 10,
    }),
  );
  assert.doesNotThrow(() =>
    admit({
      wave: sampleWave({
        quotaMode: "tokens",
        limits: limits({ maxCostMicros: 0 }),
      }),
      entries: [],
      candidateCostMicros: 99_999,
    }),
  );
  assert.throws(
    () =>
      admit({
        wave: sampleWave({
          quotaMode: "tokens",
          limits: limits({ maxCostMicros: 10 }),
        }),
        entries: [],
        candidateCostMicros: 11,
      }),
    /cost ceiling/,
  );
  assert.doesNotThrow(() =>
    admit({
      wave: sampleWave({
        quotaMode: "quota",
        limits: limits({ maxCostMicros: 0 }),
      }),
      entries: [],
      candidateCostMicros: 99_999,
    }),
  );

  assert.throws(
    () =>
      admit({
        wave: sampleWave({
          quotaMode: "usd",
          limits: limits({ maxCostMicros: 16 }),
        }),
        entries: overCost,
        candidateCostMicros: 2,
      }),
    /cost ceiling/,
  );
  assert.doesNotThrow(() =>
    admit({
      wave: sampleWave({
        quotaMode: "usd",
        limits: limits({ maxCostMicros: 17 }),
      }),
      entries: overCost,
      candidateCostMicros: 2,
    }),
  );
});

test("mutation: failClosedWithoutRates only USD without rates", () => {
  assert.throws(
    () => failClosedWithoutRates("usd", false),
    (err: unknown) => err instanceof WaveError && err.code === "usage_indeterminate",
  );
  assert.doesNotThrow(() => failClosedWithoutRates("usd", true));
  assert.doesNotThrow(() => failClosedWithoutRates("tokens", false));
  assert.doesNotThrow(() => failClosedWithoutRates("quota", false));
});

test("mutation: applySettlement INDETERMINATE/zero/undefined cost/updatedAt", () => {
  const fromIndeterminate = applySettlement(entry("INDETERMINATE"), 9, 2, 44);
  assert.equal(fromIndeterminate.state, "COMMITTED");
  assert.equal(fromIndeterminate.tokensActual, 9);
  assert.equal(fromIndeterminate.costActualMicros, 2);
  assert.equal(fromIndeterminate.updatedAt, 44);

  const zeroTokens = applySettlement(entry("RESERVED"), 0, 5, 77);
  assert.equal(zeroTokens.state, "COMMITTED");
  assert.equal(zeroTokens.tokensActual, 0);
  assert.equal(zeroTokens.costActualMicros, 5);
  assert.equal(zeroTokens.updatedAt, 77);

  const missingCost = applySettlement(entry("RESERVED"), 3, undefined, 88);
  assert.equal(missingCost.state, "COMMITTED");
  assert.equal(missingCost.tokensActual, 3);
  assert.equal(missingCost.costActualMicros, 0);
  assert.equal(missingCost.updatedAt, 88);
});

test("mutation: reservationCeiling uses per-stage reservation, not wave max", () => {
  const ceiling = reservationCeiling(
    limits({
      maxTokens: 50_000,
      maxCostMicros: 9_000,
      perStageReservationTokens: 123,
      perStageReservationCostMicros: 456,
    }),
  );
  assert.equal(ceiling.tokens, 123);
  assert.equal(ceiling.costMicros, 456);
});

test("mutation: canAcquire requires holder AND processIdentity; expiry is <= now", () => {
  assert.equal(
    canAcquire(lease({ holder: "a", processIdentity: "a-1", expiresAt: 10 }), 5, {
      holder: "a",
      processIdentity: "other",
    }),
    "deny",
  );
  assert.equal(
    canAcquire(lease({ holder: "a", processIdentity: "a-1", expiresAt: 10 }), 5, {
      holder: "b",
      processIdentity: "a-1",
    }),
    "deny",
  );
  assert.equal(
    canAcquire(lease({ holder: "a", processIdentity: "a-1", expiresAt: 5 }), 5, {
      holder: "a",
      processIdentity: "other",
    }),
    "acquire",
  );
  assert.equal(
    canAcquire(lease({ holder: "a", processIdentity: "a-1", expiresAt: 5 }), 5, {
      holder: "b",
      processIdentity: "b-1",
    }),
    "acquire",
  );
  assert.equal(
    canAcquire(lease({ holder: "a", processIdentity: "a-1", expiresAt: 6 }), 5, {
      holder: "b",
      processIdentity: "b-1",
    }),
    "deny",
  );
});

test("mutation: acquireLease first-acquire / hold refresh / steal / field pass-through", () => {
  const first = acquireLease({
    resourceKey: "repo-writer:/tmp/r",
    now: 50,
    ttlMs: 10,
    claimant: { holder: "a", processIdentity: "a-1", pid: 3, pidStartTime: "boot" },
    waveId: "w1",
    ticketId: "t1",
    taskId: "task-1",
  });
  assert.equal(first.generation, 1);
  assert.equal(first.createdAt, 50);
  assert.equal(first.expiresAt, 60);
  assert.equal(first.holder, "a");
  assert.equal(first.processIdentity, "a-1");
  assert.equal(first.pid, 3);
  assert.equal(first.pidStartTime, "boot");
  assert.equal(first.waveId, "w1");
  assert.equal(first.ticketId, "t1");
  assert.equal(first.taskId, "task-1");

  const held = acquireLease({
    current: lease({ holder: "sim", processIdentity: "sim-1", generation: 2, createdAt: 1 }),
    resourceKey: "repo-writer:/tmp/r",
    now: 5,
    ttlMs: 100,
    claimant: { holder: "sim", processIdentity: "sim-1" },
  });
  assert.equal(held.generation, 2);
  assert.equal(held.createdAt, 1);
  assert.equal(held.expiresAt, 105);

  const stolen = acquireLease({
    current: lease({ expiresAt: 1, generation: 4, createdAt: 42 }),
    resourceKey: "repo-writer:/tmp/r",
    now: 5,
    ttlMs: 100,
    claimant: { holder: "b", processIdentity: "b-1" },
    waveId: "w-steal",
    ticketId: "t-steal",
    taskId: "task-steal",
  });
  assert.equal(stolen.generation, 5);
  assert.equal(stolen.createdAt, 42);
  assert.equal(stolen.expiresAt, 105);
  assert.equal(stolen.waveId, "w-steal");
  assert.equal(stolen.ticketId, "t-steal");
  assert.equal(stolen.taskId, "task-steal");
});

test("mutation: releaseLease PID-reuse start-time AND-chain", () => {
  assert.throws(
    () =>
      releaseLease({
        current: lease({ pid: 7, pidStartTime: "start-a" }),
        claimant: { holder: "sim", processIdentity: "sim-1", pid: 7, pidStartTime: "start-b" },
        expectedGeneration: 2,
        now: 5,
      }),
    /PID start-time|PID reuse/,
  );
  assert.doesNotThrow(() =>
    releaseLease({
      current: lease({ pid: 7, pidStartTime: "start-a" }),
      claimant: { holder: "sim", processIdentity: "sim-1", pid: 7, pidStartTime: "start-a" },
      expectedGeneration: 2,
      now: 5,
    }),
  );
  assert.doesNotThrow(() =>
    releaseLease({
      current: lease({ pid: 7, pidStartTime: undefined }),
      claimant: { holder: "sim", processIdentity: "sim-1", pid: 7, pidStartTime: "start-b" },
      expectedGeneration: 2,
      now: 5,
    }),
  );
  assert.doesNotThrow(() =>
    releaseLease({
      current: lease({ pid: 7, pidStartTime: "start-a" }),
      claimant: { holder: "sim", processIdentity: "sim-1", pid: 7 },
      expectedGeneration: 2,
      now: 5,
    }),
  );
  assert.doesNotThrow(() =>
    releaseLease({
      current: lease({ pid: undefined, pidStartTime: "start-a" }),
      claimant: { holder: "sim", processIdentity: "sim-1", pid: 7, pidStartTime: "start-b" },
      expectedGeneration: 2,
      now: 5,
    }),
  );
  assert.doesNotThrow(() =>
    releaseLease({
      current: lease({ pid: 7, pidStartTime: "start-a" }),
      claimant: { holder: "sim", processIdentity: "sim-1", pidStartTime: "start-b" },
      expectedGeneration: 2,
      now: 5,
    }),
  );
});

test("mutation: safety limit equalities and omitted operator/ticketIds", () => {
  const baseLimits = {
    maxLaunches: 4,
    maxTokens: 10_000,
    maxWallTimeMs: 60_000,
    repoConcurrency: 1 as const,
  };
  const base = {
    ticketIds: ["A", "B"],
    operatorAction: true,
    isolatedWorktree: true,
    limits: baseLimits,
  };

  assert.doesNotThrow(() =>
    assertSupervisedBoundedLaunch({
      ...base,
      ticketIds: ["A", "B", "C"],
    }),
  );
  assert.throws(
    () =>
      assertSupervisedBoundedLaunch({
        ...base,
        ticketIds: ["A", "B", "C", "D"],
      }),
    SafetyGateError,
  );

  assert.doesNotThrow(() =>
    assertSupervisedBoundedLaunch({
      ...base,
      limits: { ...baseLimits, maxLaunches: 1 },
    }),
  );
  assert.doesNotThrow(() =>
    assertSupervisedBoundedLaunch({
      ...base,
      limits: { ...baseLimits, maxLaunches: SAFETY.supervisedMaxLaunches },
    }),
  );
  assert.throws(
    () =>
      assertSupervisedBoundedLaunch({
        ...base,
        limits: { ...baseLimits, maxLaunches: 0 },
      }),
    SafetyGateError,
  );
  assert.throws(
    () =>
      assertSupervisedBoundedLaunch({
        ...base,
        limits: { ...baseLimits, maxLaunches: SAFETY.supervisedMaxLaunches + 1 },
      }),
    SafetyGateError,
  );

  assert.doesNotThrow(() =>
    assertSupervisedBoundedLaunch({
      ...base,
      limits: { ...baseLimits, maxTokens: 1 },
    }),
  );
  assert.doesNotThrow(() =>
    assertSupervisedBoundedLaunch({
      ...base,
      limits: { ...baseLimits, maxTokens: SAFETY.supervisedMaxTokens },
    }),
  );
  assert.throws(
    () =>
      assertSupervisedBoundedLaunch({
        ...base,
        limits: { ...baseLimits, maxTokens: 0 },
      }),
    SafetyGateError,
  );
  assert.throws(
    () =>
      assertSupervisedBoundedLaunch({
        ...base,
        limits: { ...baseLimits, maxTokens: SAFETY.supervisedMaxTokens + 1 },
      }),
    SafetyGateError,
  );

  assert.doesNotThrow(() =>
    assertSupervisedBoundedLaunch({
      ...base,
      limits: { ...baseLimits, maxWallTimeMs: 0 },
    }),
  );
  assert.doesNotThrow(() =>
    assertSupervisedBoundedLaunch({
      ...base,
      limits: { ...baseLimits, maxWallTimeMs: 24 * 60 * 60_000 },
    }),
  );
  assert.throws(
    () =>
      assertSupervisedBoundedLaunch({
        ...base,
        limits: { ...baseLimits, maxWallTimeMs: -1 },
      }),
    SafetyGateError,
  );

  assert.throws(() => assertBoundedWaveRequest({}), SafetyGateError);
  assert.throws(
    () =>
      assertSupervisedBoundedLaunch({
        ticketIds: ["A"],
        isolatedWorktree: true,
        limits: baseLimits,
      }),
    SafetyGateError,
  );
});
