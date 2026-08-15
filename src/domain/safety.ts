import { SafetyGateError } from "./errors.js";

/**
 * Hard safety gates. Production drain / overnight / unrestricted modes stay
 * disabled even if a caller asks. Phase 4 runbook documents the human revisit.
 */
export const SAFETY = Object.freeze({
  productionDrainEnabled: false,
  overnightEnabled: false,
  unrestrictedDrainEnabled: false,
  recurringLlmPollingEnabled: false,
  autonomousOvernightEnabled: false,
  deployPushEnabled: false,
  productionWorkerLaunchEnabled: false,
  allowActiveGatewayRestart: false,
  allowActiveGatewayConfigMutation: false,
  supervisedBoundedLaunchAllowed: true,
  supervisedMaxTickets: 3,
  supervisedMaxLaunches: 6,
  supervisedMaxTokens: 50_000,
  supervisedMaxWallTimeMs: 30 * 60_000,
  supervisedOneTicketLaunchAllowed: true,
});

export function assertBoundedWaveRequest(input: {
  drainEverything?: boolean;
  overnight?: boolean;
  recurringLlmPolling?: boolean;
  ticketIds?: string[];
}): void {
  if (input.drainEverything || SAFETY.unrestrictedDrainEnabled) {
    throw new SafetyGateError("unrestricted drain-everything is disabled.");
  }
  if (input.overnight || SAFETY.overnightEnabled || SAFETY.autonomousOvernightEnabled) {
    throw new SafetyGateError("overnight execution remains an explicit operator human gate.");
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
    throw new SafetyGateError("supervised launch requires an explicit immutable list of at most 3 tickets.");
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
