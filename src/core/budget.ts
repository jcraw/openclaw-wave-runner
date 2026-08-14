import { AdmissionDeniedError, WaveError } from "../domain/errors.js";
import type {
  BudgetEntry,
  BudgetState,
  QuotaMode,
  WaveCounters,
  WaveLimits,
  WaveRecord,
} from "../domain/types.js";

export type BudgetSnapshot = {
  committedTokens: number;
  reservedTokens: number;
  indeterminateTokens: number;
  committedCostMicros: number;
  reservedCostMicros: number;
  indeterminateCostMicros: number;
};

export function summarizeBudgets(entries: BudgetEntry[]): BudgetSnapshot {
  const snap: BudgetSnapshot = {
    committedTokens: 0,
    reservedTokens: 0,
    indeterminateTokens: 0,
    committedCostMicros: 0,
    reservedCostMicros: 0,
    indeterminateCostMicros: 0,
  };
  for (const entry of entries) {
    if (entry.state === "COMMITTED") {
      snap.committedTokens += entry.tokensActual ?? 0;
      snap.committedCostMicros += entry.costActualMicros ?? 0;
    } else if (entry.state === "RESERVED") {
      snap.reservedTokens += entry.tokensReserved;
      snap.reservedCostMicros += entry.costReservedMicros;
    } else if (entry.state === "INDETERMINATE") {
      snap.indeterminateTokens += entry.tokensReserved;
      snap.indeterminateCostMicros += entry.costReservedMicros;
    }
  }
  return snap;
}

export function countersFromBudgets(
  entries: BudgetEntry[],
  launches: number,
  startedAt?: number,
): WaveCounters {
  const snap = summarizeBudgets(entries);
  return {
    committedTokens: snap.committedTokens,
    reservedTokens: snap.reservedTokens,
    indeterminateTokens: snap.indeterminateTokens,
    committedCostMicros: snap.committedCostMicros,
    reservedCostMicros: snap.reservedCostMicros,
    indeterminateCostMicros: snap.indeterminateCostMicros,
    launches,
    ...(startedAt !== undefined ? { startedAt } : {}),
  };
}

export function admitReservation(input: {
  wave: WaveRecord;
  entries: BudgetEntry[];
  candidateTokens: number;
  candidateCostMicros: number;
  now: number;
  extraLaunch?: boolean;
}): void {
  const { wave, entries, candidateTokens, candidateCostMicros, now } = input;
  if (wave.cancelRequested) {
    throw new AdmissionDeniedError("wave cancellation is sticky.");
  }
  if (wave.stopAt !== undefined && now >= wave.stopAt) {
    throw new AdmissionDeniedError("absolute stop_at has passed.");
  }
  if (wave.deadlineMs !== undefined && wave.counters.startedAt !== undefined) {
    if (now - wave.counters.startedAt >= wave.deadlineMs) {
      throw new AdmissionDeniedError("max wall-time deadline has passed.");
    }
  }
  if (wave.counters.startedAt !== undefined && now - wave.counters.startedAt >= wave.limits.maxWallTimeMs) {
    throw new AdmissionDeniedError("max_wall_time has elapsed.");
  }
  if (input.extraLaunch && wave.counters.launches + 1 > wave.limits.maxLaunches) {
    throw new AdmissionDeniedError("max_launches would be exceeded.");
  }
  const snap = summarizeBudgets(entries);
  const tokenUsed =
    snap.committedTokens + snap.reservedTokens + snap.indeterminateTokens + candidateTokens;
  if (tokenUsed > wave.limits.maxTokens) {
    throw new AdmissionDeniedError(
      `token ceiling ${wave.limits.maxTokens} < committed+reserved+indeterminate+candidate ${tokenUsed}.`,
    );
  }
  if (wave.quotaMode === "usd" || wave.limits.maxCostMicros > 0) {
    const costUsed =
      snap.committedCostMicros +
      snap.reservedCostMicros +
      snap.indeterminateCostMicros +
      candidateCostMicros;
    if (costUsed > wave.limits.maxCostMicros) {
      throw new AdmissionDeniedError(
        `cost ceiling ${wave.limits.maxCostMicros} micros would be exceeded.`,
      );
    }
  }
}

export function failClosedWithoutRates(quotaMode: QuotaMode, hasRates: boolean): void {
  if (quotaMode === "usd" && !hasRates) {
    throw new WaveError(
      "USD quota mode fails closed without a supported public rate/usage contract.",
      "usage_indeterminate",
    );
  }
}

export function applySettlement(
  entry: BudgetEntry,
  actualTokens: number | undefined,
  actualCostMicros: number | undefined,
  now: number,
): BudgetEntry {
  if (entry.state !== "RESERVED" && entry.state !== "INDETERMINATE") {
    return entry;
  }
  if (actualTokens === undefined) {
    return { ...entry, state: "INDETERMINATE", updatedAt: now };
  }
  return {
    ...entry,
    tokensActual: actualTokens,
    costActualMicros: actualCostMicros ?? 0,
    state: "COMMITTED",
    updatedAt: now,
  };
}

export function markIndeterminate(entry: BudgetEntry, now: number): BudgetEntry {
  if (entry.state === "COMMITTED" || entry.state === "RELEASED") return entry;
  return { ...entry, state: "INDETERMINATE", updatedAt: now };
}

export function releaseIfUnused(entry: BudgetEntry, now: number): BudgetEntry {
  if (entry.state !== "RESERVED") return entry;
  return {
    ...entry,
    state: "RELEASED",
    tokensActual: 0,
    costActualMicros: 0,
    updatedAt: now,
  };
}

export function reservationCeiling(limits: WaveLimits): {
  tokens: number;
  costMicros: number;
} {
  return {
    tokens: limits.perStageReservationTokens,
    costMicros: limits.perStageReservationCostMicros,
  };
}

export function assertBudgetStatesForTerminal(entries: BudgetEntry[]): void {
  const open = entries.filter((entry) => entry.state === "RESERVED");
  if (open.length > 0) {
    throw new WaveError(
      "Terminal wave requires every budget entry to be COMMITTED, INDETERMINATE, or RELEASED.",
      "budget_open",
    );
  }
}

export const OPEN_BUDGET_STATES: ReadonlySet<BudgetState> = new Set(["RESERVED"]);
