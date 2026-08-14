import assert from "node:assert/strict";
import test from "node:test";

import {
  applySettlement,
  assertBudgetStatesForTerminal,
  markIndeterminate,
  releaseIfUnused,
} from "../src/core/budget.js";
import { acquireLease, canAcquire, isLeaseStale, releaseLease } from "../src/core/lease.js";
import { WaveError } from "../src/domain/errors.js";
import type { BudgetEntry, LeaseRecord } from "../src/domain/types.js";

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

test("mutation: releaseIfUnused only releases RESERVED rows", () => {
  const released = releaseIfUnused(entry("RESERVED"), 9);
  assert.equal(released.state, "RELEASED");
  assert.equal(released.tokensActual, 0);
  assert.equal(releaseIfUnused(entry("COMMITTED"), 9).state, "COMMITTED");
  assert.equal(releaseIfUnused(entry("INDETERMINATE"), 9).state, "INDETERMINATE");
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

  const next = acquireLease({
    current: lease({ expiresAt: 1 }),
    resourceKey: "repo-writer:/tmp/r",
    now: 5,
    ttlMs: 100,
    claimant: { holder: "b", processIdentity: "b-1" },
  });
  assert.equal(next.generation, 3);

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
