import { SafetyGateError } from "../domain/errors.js";
import {
  SAFETY,
  assertBoundedWaveRequest,
  assertSupervisedBoundedLaunch,
} from "../domain/safety.js";
import type {
  CreateWaveInput,
  FrozenManifest,
  FrozenTicket,
  SupervisedStartOptions,
  TicketRun,
  WaveView,
} from "../domain/types.js";
import { DEFAULT_LIMITS } from "../domain/types.js";
import { deriveWriterScope } from "../domain/writer-scope.js";
import { countersFromBudgets } from "./budget.js";
import type { ControllerContext } from "./controller-context.js";
import { inspect, recordEvent } from "./controller-context.js";
import { hashManifest, topologicalOrder, validateManifest } from "./manifest.js";
import { TICKET_NEXT, TICKET_OWNERS, WAVE_NEXT, WAVE_OWNERS } from "./state-machine.js";

export function buildManifest(
  ctrl: ControllerContext,
  input: CreateWaveInput,
  tickets: FrozenTicket[],
  baseSha: string,
): FrozenManifest {
  const ordered = topologicalOrder(tickets).map((ticket, index) => ({
    ...ticket,
    order: index + 1,
  }));
  return {
    schema: 1,
    waveId: input.waveId,
    repoPath: input.repoPath,
    baseSha,
    tickets: ordered,
    limits: input.limits,
    quotaMode: input.quotaMode ?? "tokens",
    stopAt: input.stopAt,
    deadlineMs: input.deadlineMs,
    createdAt: ctrl.clock.now(),
    drainEverything: false,
    overnight: false,
    recurringLlmPolling: false,
    deployPush: false,
    productionDrain: false,
    operatorActionRequired: input.supervisedBoundedPilot === true || input.supervisedOneTicket === true,
    supervisedBoundedPilot: input.supervisedBoundedPilot === true || input.supervisedOneTicket === true,
    supervisedOneTicket:
      (input.supervisedBoundedPilot === true || input.supervisedOneTicket === true) &&
      ordered.length === 1,
  };
}

export function ticketFromFrozen(waveId: string, ticket: FrozenTicket): TicketRun {
  return {
    waveId,
    ticketId: ticket.ticketId,
    contentHash: ticket.contentHash,
    title: ticket.title,
    dependsOn: ticket.dependsOn,
    order: ticket.order,
    sourcePath: ticket.sourcePath,
    stage: "NONE",
    status: "PENDING",
    revision: 0,
    owner: TICKET_OWNERS.PENDING,
    nextAction: TICKET_NEXT.PENDING,
    planClass: ticket.planClass,
    verifyCommand: ticket.verifyCommand,
    provider: ticket.provider,
    model: ticket.model,
    humanHold: ticket.humanHold,
    humanHoldReason: ticket.humanHoldReason,
    writerScope: ticket.writerScope || deriveWriterScope(ticket),
    product: ticket.product,
    game: ticket.game,
  };
}

export function assertLaunchAllowed(
  ctrl: ControllerContext,
  view: WaveView,
  options: SupervisedStartOptions,
): void {
  // productionDrain / unrestricted stay hard-off via SAFETY flags.
  // Supervised bounded launch is the intentional real-worker path.
  if (SAFETY.productionDrainEnabled) {
    throw new SafetyGateError("production backlog drain is disabled.");
  }
  if (ctrl.launchMode === "mock") return;
  if (ctrl.launchMode !== "supervised-bounded" && ctrl.launchMode !== "supervised-one-ticket") {
    throw new SafetyGateError("unsupported real worker launch mode.");
  }
  if (!options.supervisedBoundedPilot && !options.supervisedOneTicket) {
    throw new SafetyGateError("real worker start requires explicit supervised=true operator action.");
  }
  assertSupervisedBoundedLaunch({
    ticketIds: view.tickets.map((ticket) => ticket.ticketId),
    operatorAction: options.operatorAction,
    isolatedWorktree: Boolean(ctrl.worktreeRoot),
    deployPush: false,
    gatewayMutate: false,
    limits: view.wave.limits,
  });
  if (!view.manifest.supervisedBoundedPilot) {
    throw new SafetyGateError("wave was not frozen as a supervised bounded pilot.");
  }
}

export async function dryRun(ctrl: ControllerContext, input: CreateWaveInput) {
  assertBoundedWaveRequest(input);
  if (input.supervisedBoundedPilot || input.supervisedOneTicket) {
    assertSupervisedBoundedLaunch({
      ticketIds: input.ticketIds,
      operatorAction: input.operatorAction,
      isolatedWorktree: Boolean(input.isolatedWorktreeRoot || ctrl.worktreeRoot),
      deployPush: false,
      gatewayMutate: false,
      limits: input.limits,
    });
  }
  const tickets = await ctrl.tracker.snapshot({
    ticketIds: input.ticketIds,
    repoPath: input.repoPath,
  });
  const baseSha = await ctrl.workspace.currentHead(input.repoPath);
  const manifest = buildManifest(ctrl, input, tickets, baseSha);
  validateManifest(manifest);
  return {
    ok: true,
    waveId: manifest.waveId,
    manifestHash: hashManifest(manifest),
    ticketCount: manifest.tickets.length,
    order: manifest.tickets.map((t) => t.ticketId),
    limits: manifest.limits,
    safety: { ...SAFETY },
  };
}

export async function createWave(
  ctrl: ControllerContext,
  input: CreateWaveInput,
  eventId: string,
): Promise<WaveView> {
  assertBoundedWaveRequest(input);
  if (input.supervisedBoundedPilot || input.supervisedOneTicket) {
    assertSupervisedBoundedLaunch({
      ticketIds: input.ticketIds,
      operatorAction: input.operatorAction,
      isolatedWorktree: Boolean(input.isolatedWorktreeRoot || ctrl.worktreeRoot),
      deployPush: false,
      gatewayMutate: false,
      limits: input.limits,
    });
    if (input.supervisedOneTicket && !input.supervisedBoundedPilot && input.ticketIds.length !== 1) {
      throw new SafetyGateError(
        "supervised one-ticket compatibility mode requires an explicit singleton ticket list.",
      );
    }
  }
  const existing = ctrl.db.getWave(input.waveId);
  if (existing) {
    const frozen = JSON.parse(existing.manifestJson) as FrozenManifest;
    if (
      frozen.repoPath !== input.repoPath ||
      JSON.stringify(frozen.tickets.map((ticket) => ticket.ticketId)) !== JSON.stringify(input.ticketIds)
    ) {
      throw new SafetyGateError(
        `wave ${input.waveId} already exists with a different immutable repository/ticket list.`,
      );
    }
    return inspect(ctrl, input.waveId);
  }
  const tickets = await ctrl.tracker.snapshot({
    ticketIds: input.ticketIds,
    repoPath: input.repoPath,
  });
  const baseSha = await ctrl.workspace.currentHead(input.repoPath);
  const manifest = buildManifest(ctrl, input, tickets, baseSha);
  validateManifest(manifest);
  const now = ctrl.clock.now();
  const manifestJson = JSON.stringify(manifest);
  ctrl.db.transaction(() => {
    recordEvent(ctrl, eventId, input.waveId, "create", { ticketIds: input.ticketIds });
    ctrl.db.putWave({
      waveId: input.waveId,
      manifestJson,
      manifestHash: hashManifest(manifest),
      repoPath: input.repoPath,
      baseSha,
      status: "DRAFT",
      revision: 0,
      deadlineMs: input.deadlineMs,
      stopAt: input.stopAt,
      limits: input.limits,
      counters: countersFromBudgets([], 0),
      owner: WAVE_OWNERS.DRAFT,
      nextAction: WAVE_NEXT.DRAFT,
      createdAt: now,
      updatedAt: now,
      cancelRequested: false,
      quotaMode: input.quotaMode ?? "tokens",
    });
    for (const ticket of manifest.tickets) {
      ctrl.db.putTicket(ticketFromFrozen(input.waveId, ticket));
    }
  });
  return inspect(ctrl, input.waveId);
}

export function defaultCreateInput(
  waveId: string,
  repoPath: string,
  ticketIds: string[],
  limits: Partial<CreateWaveInput["limits"]> = {},
): CreateWaveInput {
  return {
    waveId,
    repoPath,
    ticketIds,
    limits: { ...DEFAULT_LIMITS, ...limits },
  };
}
