import { SafetyGateError, WaveError } from "../domain/errors.js";
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
import { countersFromBudgets, failClosedWithoutRates } from "./budget.js";
import type { ControllerContext } from "./controller-context.js";
import { inspect, recordEvent } from "./controller-context.js";
import { hashManifest, topologicalOrder, validateManifest } from "./manifest.js";
import { collectDirtyOverlapBlockers, type AdmitBlocker } from "./admit-overlap.js";
import { canonicalRepoIdentity } from "./repo-identity.js";
import { TICKET_NEXT, TICKET_OWNERS, WAVE_NEXT, WAVE_OWNERS } from "./state-machine.js";

export type { AdmitBlocker };

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

function verifyMissing(ticket: FrozenTicket): boolean {
  return !ticket.verifyCommand?.trim();
}

export function collectAdmitBlockers(tickets: FrozenTicket[]): AdmitBlocker[] {
  const blockers: AdmitBlocker[] = [];
  for (const ticket of tickets) {
    if (verifyMissing(ticket)) {
      blockers.push({
        ticketId: ticket.ticketId,
        code: "missing_verify",
        message: "verifyCommand is empty or missing",
      });
    }
    if (ticket.humanHold) {
      blockers.push({
        ticketId: ticket.ticketId,
        code: "human_hold",
        message: ticket.humanHoldReason ?? "human hold",
      });
    }
  }
  const byScope = new Map<string, string[]>();
  for (const ticket of tickets) {
    const scope = ticket.writerScope || deriveWriterScope(ticket);
    const ids = byScope.get(scope) ?? [];
    ids.push(ticket.ticketId);
    byScope.set(scope, ids);
  }
  for (const [scope, ids] of byScope) {
    if (ids.length < 2) continue;
    for (const ticketId of ids) {
      blockers.push({
        ticketId,
        code: "shared_writer_scope",
        message: `shares writer scope ${scope} with ${ids.filter((id) => id !== ticketId).join(", ")}`,
      });
    }
  }
  return blockers;
}

export function assertTicketsHaveVerify(tickets: FrozenTicket[]): void {
  const missing = tickets.filter(verifyMissing).map((ticket) => ticket.ticketId);
  if (missing.length) {
    throw new WaveError(`missing_verify: ${missing.join(", ")}`, "missing_verify");
  }
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
  failClosedWithoutRates(input.quotaMode ?? "tokens", false);
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
  const repoPath = canonicalRepoIdentity(input.repoPath);
  const tickets = await ctrl.tracker.snapshot({
    ticketIds: input.ticketIds,
    repoPath,
  });
  const admitBlockers = [
    ...collectAdmitBlockers(tickets),
    ...(await collectDirtyOverlapBlockers(ctrl.workspace, repoPath, tickets)),
  ];
  assertTicketsHaveVerify(tickets);
  const baseSha = await ctrl.workspace.currentHead(repoPath);
  const manifest = buildManifest(ctrl, { ...input, repoPath }, tickets, baseSha);
  validateManifest(manifest);
  return {
    ok: true,
    waveId: manifest.waveId,
    manifestHash: hashManifest(manifest),
    ticketCount: manifest.tickets.length,
    order: manifest.tickets.map((t) => t.ticketId),
    limits: manifest.limits,
    safety: { ...SAFETY },
    admitBlockers,
  };
}

export async function createWave(
  ctrl: ControllerContext,
  input: CreateWaveInput,
  eventId: string,
): Promise<WaveView> {
  assertBoundedWaveRequest(input);
  failClosedWithoutRates(input.quotaMode ?? "tokens", false);
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
  const repoPath = canonicalRepoIdentity(input.repoPath);
  const existing = ctrl.db.getWave(input.waveId);
  if (existing) {
    const frozen = JSON.parse(existing.manifestJson) as FrozenManifest;
    if (
      frozen.repoPath !== repoPath ||
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
    repoPath,
  });
  assertTicketsHaveVerify(tickets);
  const baseSha = await ctrl.workspace.currentHead(repoPath);
  const manifest = buildManifest(ctrl, { ...input, repoPath }, tickets, baseSha);
  validateManifest(manifest);
  const now = ctrl.clock.now();
  const manifestJson = JSON.stringify(manifest);
  ctrl.db.transaction(() => {
    recordEvent(ctrl, eventId, input.waveId, "create", { ticketIds: input.ticketIds });
    ctrl.db.putWave({
      waveId: input.waveId,
      manifestJson,
      manifestHash: hashManifest(manifest),
      repoPath,
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
