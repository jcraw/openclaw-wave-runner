import { SafetyGateError } from "./errors.js";

export const PRODUCTION_WORKER_DISABLED_MESSAGE =
  "Wave Runner production worker launch is disabled; use tools/kick_openclaw_specialist.sh " +
  "for named specialists or tools/run_detached_builder.sh for code work.";

/**
 * Hard safety gates (WR-012/015).
 *
 * Distinctions:
 * - autonomousOvernight / recurringLlmPolling / unrestrictedDrain = OFF
 *   (no auto cron, no LLM control loop, no "drain everything forever" without selection).
 * - operatorOvernightDrain = OK when Jason/operator explicitly kicks drain --eligible
 *   (may run all night; no wall by default; still no LLM orchestrator).
 * - productionDrainEnabled stays false: operator drain is supervised lanes, not a
 *   separate production-only mode.
 */
export const SAFETY = Object.freeze({
  productionDrainEnabled: false,
  overnightEnabled: false,
  unrestrictedDrainEnabled: false,
  recurringLlmPollingEnabled: false,
  autonomousOvernightEnabled: false,
  /** Explicit operator-kicked long/overnight drain is allowed (WR-015). */
  operatorOvernightDrainAllowed: true,
  deployPushEnabled: false,
  productionWorkerLaunchEnabled: false,
  allowActiveGatewayRestart: false,
  allowActiveGatewayConfigMutation: false,
  supervisedBoundedLaunchAllowed: true,
  supervisedMaxTickets: 8,
  supervisedMaxLaunches: 10,
  supervisedMaxTokens: 500_000,
  /** 0 = no elapsed-time deadline by default (WR-012). */
  supervisedMaxWallTimeMs: 0,
  supervisedOneTicketLaunchAllowed: true,
  /** Default lease TTL for live supervised workers (2h). */
  supervisedLeaseTtlMs: 2 * 60 * 60_000,
});

export function assertBoundedWaveRequest(input: {
  drainEverything?: boolean;
  overnight?: boolean;
  /** Operator-kicked overnight drain (WR-015); not autonomous overnight. */
  operatorOvernight?: boolean;
  recurringLlmPolling?: boolean;
  ticketIds?: string[];
}): void {
  if (input.drainEverything || SAFETY.unrestrictedDrainEnabled) {
    throw new SafetyGateError("unrestricted drain-everything is disabled.");
  }
  // Autonomous / unprompted overnight stays off. Operator overnight is separate.
  if (
    (input.overnight && !input.operatorOvernight) ||
    SAFETY.overnightEnabled ||
    SAFETY.autonomousOvernightEnabled
  ) {
    throw new SafetyGateError(
      "autonomous overnight remains off; use operator drain --eligible (optionally overnight).",
    );
  }
  if (input.operatorOvernight && !SAFETY.operatorOvernightDrainAllowed) {
    throw new SafetyGateError("operator overnight drain is disabled.");
  }
  if (input.recurringLlmPolling || SAFETY.recurringLlmPollingEnabled) {
    throw new SafetyGateError("recurring LLM polling is disabled.");
  }
  if (SAFETY.productionDrainEnabled) {
    throw new SafetyGateError("production backlog drain is disabled.");
  }
  if (!input.ticketIds || input.ticketIds.length === 0) {
    throw new SafetyGateError("a wave requires an explicit ticket selection.");
  }
}

export function assertNotProductionWorker(profile: "disposable" | "production" | string): void {
  if (profile === "production" || SAFETY.productionWorkerLaunchEnabled) {
    throw new SafetyGateError("production worker launches are disabled.");
  }
}

export function assertSupervisedBoundedLaunch(input: {
  ticketIds?: string[];
  operatorAction?: boolean;
  isolatedWorktree?: boolean;
  deployPush?: boolean;
  gatewayMutate?: boolean;
  limits?: {
    maxLaunches: number;
    maxTokens: number;
    maxWallTimeMs: number;
    repoConcurrency: number;
  };
}): void {
  assertBoundedWaveRequest({ ticketIds: input.ticketIds });
  if (SAFETY.productionWorkerLaunchEnabled || SAFETY.productionDrainEnabled) {
    throw new SafetyGateError("production worker launches and drain remain disabled.");
  }
  if (!SAFETY.supervisedBoundedLaunchAllowed) {
    throw new SafetyGateError("supervised bounded launch is disabled.");
  }
  if (input.operatorAction !== true) {
    throw new SafetyGateError("supervised launch requires an explicit operator action.");
  }
  if (!input.ticketIds || input.ticketIds.length < 1 || input.ticketIds.length > SAFETY.supervisedMaxTickets) {
    throw new SafetyGateError(
      `supervised launch requires an explicit immutable list of at most ${SAFETY.supervisedMaxTickets} tickets.`,
    );
  }
  if (new Set(input.ticketIds).size !== input.ticketIds.length) {
    throw new SafetyGateError("supervised ticket list must not contain duplicates.");
  }
  if (!input.isolatedWorktree) {
    throw new SafetyGateError("supervised launch requires an isolated worktree.");
  }
  if (input.deployPush || SAFETY.deployPushEnabled) {
    throw new SafetyGateError("deploy/push is disabled.");
  }
  if (
    input.gatewayMutate ||
    SAFETY.allowActiveGatewayRestart ||
    SAFETY.allowActiveGatewayConfigMutation
  ) {
    throw new SafetyGateError("active Gateway restart/config mutation is disabled.");
  }
  if (input.limits) {
    if (input.limits.repoConcurrency !== 1) {
      throw new SafetyGateError("supervised repository writer concurrency is fixed at 1.");
    }
    if (input.limits.maxLaunches < 1 || input.limits.maxLaunches > SAFETY.supervisedMaxLaunches) {
      throw new SafetyGateError(`supervised maxLaunches must be 1-${SAFETY.supervisedMaxLaunches}.`);
    }
    if (input.limits.maxTokens < 1 || input.limits.maxTokens > SAFETY.supervisedMaxTokens) {
      throw new SafetyGateError(`supervised maxTokens must be 1-${SAFETY.supervisedMaxTokens}.`);
    }
    if (input.limits.maxWallTimeMs < 0) {
      throw new SafetyGateError("supervised maxWallTimeMs must be >= 0 (0 = no elapsed-time deadline).");
    }
  }
}

/** Compatibility wrapper retained for callers of the Phase 5 singleton API. */
export function assertSupervisedOneTicketLaunch(input: Parameters<typeof assertSupervisedBoundedLaunch>[0]): void {
  assertSupervisedBoundedLaunch(input);
  if (!input.ticketIds || input.ticketIds.length !== 1) {
    throw new SafetyGateError("supervised one-ticket launch requires an explicit singleton ticket list.");
  }
}
