import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { DuplicateEventError, SafetyGateError, WaveError } from "../domain/errors.js";
import type { Clock } from "../domain/clock.js";
import { SequentialIds } from "../domain/clock.js";
import { hashJson } from "../domain/hash.js";
import { SAFETY, assertBoundedWaveRequest, assertSupervisedBoundedLaunch } from "../domain/safety.js";
import type {
  BudgetEntry,
  CreateWaveInput,
  FrozenManifest,
  FrozenTicket,
  LaunchMode,
  LaunchOutbox,
  LaunchReceipt,
  StageName,
  SupervisedStartOptions,
  TicketRun,
  WaveRecord,
  WaveView,
} from "../domain/types.js";
import { DEFAULT_LIMITS, repoWriterKey } from "../domain/types.js";
import type {
  LaunchIntent,
  PolicyAdapter,
  TrackerAdapter,
  UsageAdapter,
  WorkerAdapter,
  WorkflowBackend,
  WorkspaceAdapter,
} from "../adapters/ports.js";
import { stageAttemptDir, stageSessionKey } from "../adapters/stage-artifacts.js";
import { WaveDatabase } from "../store/database.js";
import {
  admitReservation,
  applySettlement,
  assertBudgetStatesForTerminal,
  countersFromBudgets,
  markIndeterminate,
  reservationCeiling,
} from "./budget.js";
import { acquireLease, isLeaseStale, releaseLease, type ProcessIdentity } from "./lease.js";
import { hashManifest, topologicalOrder, validateManifest } from "./manifest.js";
import {
  claimOutbox,
  markFailed,
  markLaunched,
  markReconciling,
  markSettled,
  type OutboxBoundary,
} from "./outbox.js";
import {
  TICKET_NEXT,
  TICKET_OWNERS,
  WAVE_NEXT,
  WAVE_OWNERS,
  assertExpectedRevision,
  assertTicketTransition,
  assertWaveTransition,
  isTerminalTicket,
  isTerminalWave,
} from "./state-machine.js";

export class CrashInjectedError extends Error {
  constructor(readonly boundary: OutboxBoundary) {
    super(`Injected crash at ${boundary}`);
    this.name = "CrashInjectedError";
  }
}

export type ControllerOptions = {
  db: WaveDatabase;
  clock: Clock;
  ids?: SequentialIds;
  tracker: TrackerAdapter;
  workflow: WorkflowBackend;
  worker: WorkerAdapter;
  usage: UsageAdapter;
  workspace: WorkspaceAdapter;
  policy: PolicyAdapter;
  process: ProcessIdentity;
  leaseTtlMs?: number;
  crashAt?: OutboxBoundary | null;
  llmCalls?: { count: number };
  worktreeRoot?: string;
  artifactRoot?: string;
  launchMode?: LaunchMode;
  disableSourceMirror?: boolean;
};

export class WaveController {
  readonly db: WaveDatabase;
  readonly clock: Clock;
  readonly ids: SequentialIds;
  readonly tracker: TrackerAdapter;
  readonly workflow: WorkflowBackend;
  readonly worker: WorkerAdapter;
  readonly usage: UsageAdapter;
  readonly workspace: WorkspaceAdapter;
  readonly policy: PolicyAdapter;
  readonly process: ProcessIdentity;
  readonly leaseTtlMs: number;
  crashAt: OutboxBoundary | null;
  readonly llmCalls: { count: number };
  readonly worktreeRoot?: string;
  readonly artifactRoot?: string;
  readonly launchMode: LaunchMode;
  readonly disableSourceMirror: boolean;
  watchdogFires = 0;

  constructor(opts: ControllerOptions) {
    this.db = opts.db;
    this.clock = opts.clock;
    this.ids = opts.ids ?? new SequentialIds();
    this.tracker = opts.tracker;
    this.workflow = opts.workflow;
    this.worker = opts.worker;
    this.usage = opts.usage;
    this.workspace = opts.workspace;
    this.policy = opts.policy;
    this.process = opts.process;
    this.leaseTtlMs = opts.leaseTtlMs ?? 60_000;
    this.crashAt = opts.crashAt ?? null;
    this.llmCalls = opts.llmCalls ?? { count: 0 };
    this.worktreeRoot = opts.worktreeRoot;
    this.artifactRoot = opts.artifactRoot;
    this.launchMode = opts.launchMode ?? "mock";
    this.disableSourceMirror = opts.disableSourceMirror ?? false;
  }

  capabilities() {
    return {
      milestone: "v0",
      phases: ["M0", "P1", "P2", "P3", "P4", "P5"],
      safety: { ...SAFETY },
      productionDrainEnabled: false,
      overnightEnabled: false,
      productionWorkerLaunchEnabled: false,
      supervisedOneTicketLaunchAllowed: SAFETY.supervisedOneTicketLaunchAllowed,
      supervisedBoundedLaunchAllowed: SAFETY.supervisedBoundedLaunchAllowed,
      supervisedMaxTickets: SAFETY.supervisedMaxTickets,
      launchMode: this.launchMode,
      publicApisOnly: true,
    };
  }

  async dryRun(input: CreateWaveInput) {
    assertBoundedWaveRequest(input);
    if (input.supervisedBoundedPilot || input.supervisedOneTicket) {
      assertSupervisedBoundedLaunch({
        ticketIds: input.ticketIds,
        operatorAction: input.operatorAction,
        isolatedWorktree: Boolean(input.isolatedWorktreeRoot || this.worktreeRoot),
        deployPush: false,
        gatewayMutate: false,
        limits: input.limits,
      });
    }
    const tickets = await this.tracker.snapshot({
      ticketIds: input.ticketIds,
      repoPath: input.repoPath,
    });
    const baseSha = await this.workspace.currentHead(input.repoPath);
    const manifest = this.buildManifest(input, tickets, baseSha);
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

  private eventId(kind = "evt"): string {
    return `${kind}-${randomUUID()}`;
  }

  async create(input: CreateWaveInput, eventId = this.eventId()): Promise<WaveView> {
    assertBoundedWaveRequest(input);
    if (input.supervisedBoundedPilot || input.supervisedOneTicket) {
      assertSupervisedBoundedLaunch({
        ticketIds: input.ticketIds,
        operatorAction: input.operatorAction,
        isolatedWorktree: Boolean(input.isolatedWorktreeRoot || this.worktreeRoot),
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
    const existing = this.db.getWave(input.waveId);
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
      return this.inspect(input.waveId);
    }
    const tickets = await this.tracker.snapshot({
      ticketIds: input.ticketIds,
      repoPath: input.repoPath,
    });
    const baseSha = await this.workspace.currentHead(input.repoPath);
    const manifest = this.buildManifest(input, tickets, baseSha);
    validateManifest(manifest);
    const now = this.clock.now();
    const manifestJson = JSON.stringify(manifest);
    this.db.transaction(() => {
      this.recordEvent(eventId, input.waveId, "create", { ticketIds: input.ticketIds });
      this.db.putWave({
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
        this.db.putTicket(this.ticketFromFrozen(input.waveId, ticket));
      }
    });
    return this.inspect(input.waveId);
  }

  freeze(waveId: string, eventId = this.eventId(), expectedRevision?: number): WaveView {
    return this.mutateWave(waveId, eventId, "freeze", expectedRevision, (wave) => {
      assertWaveTransition(wave.status, "FROZEN", wave.cancelRequested);
      wave.status = "FROZEN";
      wave.owner = WAVE_OWNERS.FROZEN;
      wave.nextAction = WAVE_NEXT.FROZEN;
    });
  }

  async start(
    waveId: string,
    eventId = this.eventId(),
    expectedRevision?: number,
    options: SupervisedStartOptions = {},
  ): Promise<WaveView> {
    const view = this.inspect(waveId);
    assertExpectedRevision(view.wave.revision, expectedRevision);
    this.assertLaunchAllowed(view, options);
    if (isTerminalWave(view.wave.status)) {
      throw new WaveError(`Wave ${waveId} is already terminal (${view.wave.status}).`, "illegal_transition");
    }
    if (view.wave.status === "PAUSED") {
      throw new WaveError("Paused waves resume via resume, not start.", "illegal_transition");
    }
    if (view.wave.status === "DRAFT") this.freeze(waveId, this.eventId());
    const afterFreeze = this.inspect(waveId);
    if (afterFreeze.wave.status === "FROZEN") {
      this.mutateWave(waveId, eventId, "start", undefined, (wave) => {
        assertWaveTransition(wave.status, "RUNNING", wave.cancelRequested);
        wave.status = "RUNNING";
        wave.owner = WAVE_OWNERS.RUNNING;
        wave.nextAction = WAVE_NEXT.RUNNING;
        wave.counters = { ...wave.counters, startedAt: wave.counters.startedAt ?? this.clock.now() };
      });
    }
    const current = this.inspect(waveId);
    if (!current.wave.flowId) {
      const flow = await this.workflow.createWave({
        waveId,
        manifestHash: current.wave.manifestHash,
        goal: `Wave ${waveId}`,
        stateJson: { schema: 1, waveId, manifestHash: current.wave.manifestHash },
      });
      this.db.transaction(() => {
        const wave = this.requireWave(waveId);
        wave.flowId = flow.flowId;
        wave.updatedAt = this.clock.now();
        this.db.putWave(wave);
      });
    }
    await this.tick(waveId, options);
    return this.inspect(waveId);
  }

  pause(waveId: string, eventId = this.eventId(), expectedRevision?: number): WaveView {
    return this.mutateWave(waveId, eventId, "pause", expectedRevision, (wave) => {
      assertWaveTransition(wave.status, "PAUSED", wave.cancelRequested);
      wave.status = "PAUSED";
      wave.owner = WAVE_OWNERS.PAUSED;
      wave.nextAction = WAVE_NEXT.PAUSED;
    });
  }

  resume(waveId: string, eventId = this.eventId(), expectedRevision?: number): WaveView {
    return this.mutateWave(waveId, eventId, "resume", expectedRevision, (wave) => {
      assertWaveTransition(wave.status, "RUNNING", wave.cancelRequested);
      wave.status = "RUNNING";
      wave.owner = WAVE_OWNERS.RUNNING;
      wave.nextAction = WAVE_NEXT.RUNNING;
    });
  }

  cancel(waveId: string, eventId = this.eventId(), expectedRevision?: number): WaveView {
    this.mutateWave(waveId, eventId, "cancel", expectedRevision, (wave) => {
      wave.cancelRequested = true;
      if (!isTerminalWave(wave.status)) {
        assertWaveTransition(wave.status, "CANCELLED", true);
        wave.status = "CANCELLED";
        wave.owner = WAVE_OWNERS.CANCELLED;
        wave.nextAction = WAVE_NEXT.CANCELLED;
      }
    });
    this.db.transaction(() => {
      const now = this.clock.now();
      for (const ticket of this.db.listTickets(waveId)) {
        if (!isTerminalTicket(ticket.status)) {
          ticket.status = "CANCELLED";
          ticket.owner = TICKET_OWNERS.CANCELLED;
          ticket.nextAction = TICKET_NEXT.CANCELLED;
          ticket.revision += 1;
          this.db.putTicket(ticket);
        }
      }
      for (const budget of this.db.listBudgets(waveId)) {
        if (budget.state === "RESERVED") {
          this.db.putBudget(markIndeterminate(budget, now));
        }
      }
      this.refreshCounters(waveId);
    });
    const wave = this.requireWave(waveId);
    if (wave.flowId) {
      void this.workflow.cancelWave(wave.flowId);
    }
    return this.inspect(waveId);
  }

  approve(
    waveId: string,
    ticketId: string,
    expectedTicketRevision: number,
    eventId = this.eventId(),
  ): WaveView {
    this.recordOrThrow(eventId, waveId, "approve", { ticketId, expectedTicketRevision });
    this.db.transaction(() => {
      const wave = this.requireWave(waveId);
      if (wave.cancelRequested) throw new WaveError("Wave is cancelled.", "cancelled");
      const ticket = this.requireTicket(waveId, ticketId);
      assertExpectedRevision(ticket.revision, expectedTicketRevision);
      assertTicketTransition(ticket.status, "APPROVED", wave.cancelRequested);
      ticket.status = "APPROVED";
      ticket.owner = TICKET_OWNERS.APPROVED;
      ticket.nextAction = TICKET_NEXT.APPROVED;
      ticket.revision += 1;
      this.db.putTicket(ticket);
      if (wave.status === "WAITING_APPROVAL") {
        assertWaveTransition(wave.status, "RUNNING", wave.cancelRequested);
        wave.status = "RUNNING";
        wave.owner = WAVE_OWNERS.RUNNING;
        wave.nextAction = WAVE_NEXT.RUNNING;
        wave.revision += 1;
        wave.updatedAt = this.clock.now();
        this.db.putWave(wave);
      }
    });
    return this.inspect(waveId);
  }

  revise(waveId: string, ticketId: string, eventId = this.eventId()): WaveView {
    this.recordOrThrow(eventId, waveId, "revise", { ticketId });
    this.db.transaction(() => {
      const wave = this.requireWave(waveId);
      const ticket = this.requireTicket(waveId, ticketId);
      assertTicketTransition(ticket.status, "REVISING", wave.cancelRequested);
      ticket.status = "REVISING";
      ticket.owner = TICKET_OWNERS.REVISING;
      ticket.nextAction = TICKET_NEXT.REVISING;
      ticket.revision += 1;
      this.db.putTicket(ticket);
    });
    return this.inspect(waveId);
  }

  inspect(waveId: string): WaveView {
    const wave = this.requireWave(waveId);
    return {
      wave,
      manifest: JSON.parse(wave.manifestJson) as FrozenManifest,
      tickets: this.db.listTickets(waveId),
      stages: this.db.listStages(waveId),
      budgets: this.db.listBudgets(waveId),
      outbox: this.db.listOutbox(waveId),
      leases: this.db.listLeases(waveId),
      events: this.db.listEvents(waveId),
      artifacts: this.db.listArtifacts(waveId),
    };
  }

  project() {
    return {
      generatedAt: this.clock.now(),
      authoritative: false,
      productionDrainEnabled: false,
      overnightEnabled: false,
      productionWorkerLaunchEnabled: false,
      supervisedOneTicketLaunchAllowed: SAFETY.supervisedOneTicketLaunchAllowed,
      safety: { ...SAFETY },
      waves: this.db.listWaves().map((wave) => {
        const view = this.inspect(wave.waveId);
        return {
          waveId: wave.waveId,
          status: wave.status,
          revision: wave.revision,
          manifestHash: wave.manifestHash,
          flowId: wave.flowId,
          nextAction: wave.nextAction,
          cancelRequested: wave.cancelRequested,
          budgets: {
            committedTokens: wave.counters.committedTokens,
            reservedTokens: wave.counters.reservedTokens,
            indeterminateTokens: wave.counters.indeterminateTokens,
            launches: wave.counters.launches,
            maxTokens: wave.limits.maxTokens,
            maxLaunches: wave.limits.maxLaunches,
          },
          approvals: view.tickets
            .filter((t) => t.status === "PLAN_REVIEW")
            .map((t) => ({
              ticketId: t.ticketId,
              revision: t.revision,
              plan: t.planArtifact,
            })),
          pauseCancel: {
            canPause: wave.status === "RUNNING" || wave.status === "WAITING_APPROVAL",
            canCancel: !isTerminalWave(wave.status),
            canResume: wave.status === "PAUSED",
          },
          tickets: view.tickets.map((t) => ({
            ticketId: t.ticketId,
            status: t.status,
            stage: t.stage,
            nextAction: t.nextAction,
            plan: t.planArtifact,
            worktree: t.implWorktree,
            proof: t.verifyProof,
          })),
          runs: view.stages.map((s) => ({
            stageRunId: s.stageRunId,
            ticketId: s.ticketId,
            stage: s.stage,
            attempt: s.attempt,
            taskId: s.taskId,
            runId: s.runId,
            sessionId: s.sessionId,
            status: s.status,
          })),
          artifacts: view.artifacts.map((a) => ({
            kind: a.kind,
            path: a.path,
            ticketId: a.ticketId,
            hash: a.hash,
          })),
        };
      }),
    };
  }

  async tick(waveId: string, options: SupervisedStartOptions = {}): Promise<WaveView> {
    const wave = this.requireWave(waveId);
    if (this.launchMode !== "mock") {
      this.assertLaunchAllowed(this.inspect(waveId), options);
    }
    if (isTerminalWave(wave.status) || wave.status === "PAUSED") {
      return this.inspect(waveId);
    }
    if (this.deadlineExceeded(wave)) {
      this.stopForBudget(waveId, "deadline");
      return this.inspect(waveId);
    }
    this.refreshHeldLeases(waveId);
    this.expireStaleLeases();
    await this.reconcile(waveId);
    if (this.requireWave(waveId).status === "WAITING_APPROVAL") {
      return this.inspect(waveId);
    }
    await this.dispatchPending(waveId);
    await this.observeLaunched(waveId);
    await this.advanceReadyTickets(waveId);
    this.maybeCompleteWave(waveId);
    return this.inspect(waveId);
  }

  async runUntilIdle(
    waveId: string,
    maxSteps = 32,
    options: SupervisedStartOptions = {},
  ): Promise<WaveView> {
    for (let i = 0; i < maxSteps; i += 1) {
      const before = this.inspect(waveId);
      await this.tick(waveId, options);
      const after = this.inspect(waveId);
      if (
        isTerminalWave(after.wave.status) ||
        after.wave.status === "WAITING_APPROVAL" ||
        after.wave.status === "PAUSED" ||
        (after.wave.revision === before.wave.revision &&
          after.tickets.every((t, idx) => t.revision === before.tickets[idx]?.revision) &&
          after.outbox.every((item) => item.state === "SETTLED" || item.state === "FAILED"))
      ) {
        break;
      }
    }
    return this.inspect(waveId);
  }

  async reconcile(waveId: string): Promise<void> {
    const open = this.db.listOutbox(waveId).filter((item) =>
      item.state === "CLAIMED" || item.state === "LAUNCHED" || item.state === "RECONCILING",
    );
    for (const item of open) {
      this.db.transaction(() => {
        const current = this.db.getOutboxByIdempotency(item.idempotencyKey);
        if (!current) return;
        if (current.state === "CLAIMED" || current.state === "LAUNCHED") {
          this.db.putOutbox(markReconciling(current, this.clock.now()));
        }
      });
      const latest = this.db.getOutboxByIdempotency(item.idempotencyKey);
      if (!latest) continue;
      if (!latest.receiptJson) {
        // Crash after spawn / before receipt commit must recover the existing
        // worker identity. Never spawn again from a receipt-less row.
        const recovered = await this.worker.recover(this.intentFromOutbox(latest));
        if (!recovered) {
          continue;
        }
        this.db.transaction(() => {
          const row = this.db.getOutboxByIdempotency(latest.idempotencyKey);
          if (!row) return;
          this.db.putOutbox(markLaunched(row, JSON.stringify(recovered), this.clock.now()));
          const stage = this.db.getStageByIdempotency(latest.idempotencyKey);
          if (stage) {
            stage.taskId = recovered.taskId;
            stage.runId = recovered.runId;
            stage.sessionId = recovered.sessionId;
            stage.receiptJson = JSON.stringify(recovered);
            stage.status = "RUNNING";
            this.db.putStage(stage);
          }
        });
        continue;
      }
      const receipt = JSON.parse(latest.receiptJson) as LaunchReceipt;
      const truth = await this.worker.inspect(receipt);
      if (truth.status === "succeeded" || truth.status === "failed" || truth.status === "cancelled") {
        await this.settleOutbox(latest, receipt, truth.status, truth.outputRef, truth.summary);
      } else if (latest.receiptJson) {
        this.db.transaction(() => {
          const row = this.db.getOutboxByIdempotency(latest.idempotencyKey);
          if (row && row.state === "RECONCILING") {
            this.db.putOutbox(markLaunched(row, row.receiptJson ?? "{}", this.clock.now()));
          }
        });
      }
    }
  }

  private refreshHeldLeases(waveId: string): void {
    const now = this.clock.now();
    for (const lease of this.db.listLeases(waveId)) {
      if (
        lease.holder === this.process.holder &&
        lease.processIdentity === this.process.processIdentity
      ) {
        this.db.putLease({ ...lease, expiresAt: now + this.leaseTtlMs });
      }
    }
  }

  expireStaleLeases(): number {
    this.watchdogFires += 1;
    // Deterministic watchdog: never call an LLM.
    let expired = 0;
    for (const lease of this.db.listLeases()) {
      if (isLeaseStale(lease, this.clock.now())) {
        this.db.deleteLease(lease.resourceKey);
        expired += 1;
      }
    }
    return expired;
  }

  emergencyStop(reason = "operator emergency stop"): { stopped: string[] } {
    const stopped: string[] = [];
    for (const wave of this.db.listWaves()) {
      if (isTerminalWave(wave.status)) continue;
      this.cancel(wave.waveId, this.eventId());
      this.stopForBudget(wave.waveId, reason);
      stopped.push(wave.waveId);
    }
    return { stopped };
  }

  backup(destPath: string): { path: string; schemaVersion: number } {
    mkdirSync(dirname(destPath), { recursive: true });
    if (this.db.path === ":memory:") {
      throw new WaveError("Cannot backup an in-memory database; use a file-backed store.", "backup");
    }
    this.db.db.exec("PRAGMA wal_checkpoint(FULL);");
    copyFileSync(this.db.path, destPath);
    return { path: destPath, schemaVersion: this.db.schemaVersion() };
  }

  private buildManifest(
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
      createdAt: this.clock.now(),
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

  private assertLaunchAllowed(view: WaveView, options: SupervisedStartOptions): void {
    if (SAFETY.productionWorkerLaunchEnabled || SAFETY.productionDrainEnabled) {
      throw new SafetyGateError("production worker launches and drain remain disabled.");
    }
    if (this.launchMode === "mock") return;
    if (this.launchMode !== "supervised-bounded" && this.launchMode !== "supervised-one-ticket") {
      throw new SafetyGateError("unsupported real worker launch mode.");
    }
    if (!options.supervisedBoundedPilot && !options.supervisedOneTicket) {
      throw new SafetyGateError("real worker start requires explicit supervised=true operator action.");
    }
    assertSupervisedBoundedLaunch({
      ticketIds: view.tickets.map((ticket) => ticket.ticketId),
      operatorAction: options.operatorAction,
      isolatedWorktree: Boolean(this.worktreeRoot),
      deployPush: false,
      gatewayMutate: false,
      limits: view.wave.limits,
    });
    if (!view.manifest.supervisedBoundedPilot) {
      throw new SafetyGateError("wave was not frozen as a supervised bounded pilot.");
    }
  }

  private ticketFromFrozen(waveId: string, ticket: FrozenTicket): TicketRun {
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
    };
  }

  private mutateWave(
    waveId: string,
    eventId: string,
    type: string,
    expectedRevision: number | undefined,
    mut: (wave: WaveRecord) => void,
  ): WaveView {
    this.db.transaction(() => {
      this.recordEvent(eventId, waveId, type, {});
      const wave = this.requireWave(waveId);
      assertExpectedRevision(wave.revision, expectedRevision);
      mut(wave);
      wave.revision += 1;
      wave.updatedAt = this.clock.now();
      this.db.putWave(wave);
    });
    return this.inspect(waveId);
  }

  private recordOrThrow(eventId: string, waveId: string, type: string, payload: unknown): void {
    this.db.transaction(() => {
      this.recordEvent(eventId, waveId, type, payload);
    });
  }

  private recordEvent(eventId: string, waveId: string, type: string, payload: unknown): void {
    const inserted = this.db.insertEvent({
      eventId,
      waveId,
      type,
      payloadJson: JSON.stringify(payload),
      createdAt: this.clock.now(),
    });
    if (!inserted) {
      throw new DuplicateEventError(eventId);
    }
  }

  private requireWave(waveId: string): WaveRecord {
    const wave = this.db.getWave(waveId);
    if (!wave) throw new WaveError(`Wave not found: ${waveId}`, "not_found");
    return wave;
  }

  private requireTicket(waveId: string, ticketId: string): TicketRun {
    const ticket = this.db.getTicket(waveId, ticketId);
    if (!ticket) throw new WaveError(`Ticket ${ticketId} is not in wave ${waveId}.`, "not_found");
    return ticket;
  }

  private deadlineExceeded(wave: WaveRecord): boolean {
    const now = this.clock.now();
    if (wave.stopAt !== undefined && now >= wave.stopAt) return true;
    if (wave.counters.startedAt !== undefined) {
      if (now - wave.counters.startedAt >= wave.limits.maxWallTimeMs) return true;
      if (wave.deadlineMs !== undefined && now - wave.counters.startedAt >= wave.deadlineMs) return true;
    }
    return false;
  }

  private stopForBudget(waveId: string, reason: string): void {
    this.db.transaction(() => {
      const wave = this.requireWave(waveId);
      if (isTerminalWave(wave.status)) return;
      wave.status = "BUDGET_STOPPED";
      wave.owner = WAVE_OWNERS.BUDGET_STOPPED;
      wave.nextAction = WAVE_NEXT.BUDGET_STOPPED;
      wave.revision += 1;
      wave.updatedAt = this.clock.now();
      this.db.putWave(wave);
      for (const ticket of this.db.listTickets(waveId)) {
        if (!isTerminalTicket(ticket.status)) {
          ticket.status = "BUDGET_STOPPED";
          ticket.result = reason;
          ticket.revision += 1;
          this.db.putTicket(ticket);
        }
      }
      for (const budget of this.db.listBudgets(waveId)) {
        if (budget.state === "RESERVED") {
          this.db.putBudget(markIndeterminate(budget, this.clock.now()));
        }
      }
      this.refreshCounters(waveId);
    });
  }

  private refreshCounters(waveId: string): void {
    const wave = this.requireWave(waveId);
    wave.counters = countersFromBudgets(
      this.db.listBudgets(waveId),
      wave.counters.launches,
      wave.counters.startedAt,
    );
    this.db.putWave(wave);
  }

  private nextEligibleTicket(waveId: string): TicketRun | undefined {
    const tickets = this.db.listTickets(waveId);
    const done = new Set(tickets.filter((t) => t.status === "DONE").map((t) => t.ticketId));
    return tickets.find(
      (ticket) =>
        (ticket.status === "PENDING" || ticket.status === "REVISING") &&
        ticket.dependsOn.every((dep) => done.has(dep)),
    );
  }

  private async advanceReadyTickets(waveId: string): Promise<void> {
    const wave = this.requireWave(waveId);
    if (wave.cancelRequested || isTerminalWave(wave.status) || wave.status === "WAITING_APPROVAL") {
      return;
    }
    const openOutbox = this.db.listOutbox(waveId).some(
      (item) => item.state !== "SETTLED" && item.state !== "FAILED",
    );
    if (openOutbox) return;

    const approved = this.db.listTickets(waveId).find((t) => t.status === "APPROVED");
    if (approved) {
      await this.queueStage(waveId, approved.ticketId, "IMPL");
      return;
    }
    const inFlight = this.db.listTickets(waveId).some((t) =>
      ["CLAIMED", "PLANNING", "IMPLEMENTING", "VERIFYING"].includes(t.status),
    );
    if (inFlight) return;
    const next = this.nextEligibleTicket(waveId);
    if (next) {
      await this.queueStage(waveId, next.ticketId, next.status === "REVISING" ? "PLAN" : "PLAN");
    }
  }

  private async queueStage(waveId: string, ticketId: string, stage: StageName): Promise<void> {
    if (this.crashAt === "before_reservation") {
      throw new CrashInjectedError("before_reservation");
    }
    const wave = this.requireWave(waveId);
    if (wave.cancelRequested) {
      throw new WaveError("Cancellation forbids new child tasks.", "cancelled");
    }
    const ticket = this.requireTicket(waveId, ticketId);
    const attempt = this.db.listStages(waveId).filter((s) => s.ticketId === ticketId && s.stage === stage).length + 1;
    if (attempt - 1 > wave.limits.maxRetriesPerStage) {
      throw new WaveError("max_retries_per_stage exceeded.", "admission_denied");
    }
    const provider = ticket.provider ?? "mock";
    const activeProvider = this.db
      .listOutbox(waveId)
      .filter((item) => item.state !== "SETTLED" && item.state !== "FAILED")
      .filter((item) => this.requireTicket(waveId, item.ticketId).provider === provider).length;
    if (activeProvider >= wave.limits.perProviderConcurrency) {
      throw new WaveError("per-provider launch cap reached.", "admission_denied");
    }
    const ceiling = reservationCeiling(wave.limits);
    const idempotencyKey = `${waveId}:${ticketId}:${stage}:${attempt}`;
    if (this.db.getOutboxByIdempotency(idempotencyKey)) return;

    this.db.transaction(() => {
      const live = this.requireWave(waveId);
      if (live.cancelRequested) throw new WaveError("Cancellation forbids new child tasks.", "cancelled");
      admitReservation({
        wave: live,
        entries: this.db.listBudgets(waveId),
        candidateTokens: ceiling.tokens,
        candidateCostMicros: ceiling.costMicros,
        now: this.clock.now(),
        extraLaunch: true,
      });
      if (stage === "IMPL") {
        const current = this.db.getLease(repoWriterKey(live.repoPath));
        const lease = acquireLease({
          current,
          resourceKey: repoWriterKey(live.repoPath),
          now: this.clock.now(),
          ttlMs: this.leaseTtlMs,
          claimant: this.process,
          waveId,
          ticketId,
        });
        this.db.putLease(lease);
      }
      const now = this.clock.now();
      const stageRunId = `${waveId}:stg:${randomUUID()}`;
      const budgetId = `${waveId}:bdg:${randomUUID()}`;
      const outboxId = `${waveId}:obx:${randomUUID()}`;
      const nextStatus = stage === "PLAN" ? "PLANNING" : stage === "IMPL" ? "IMPLEMENTING" : "VERIFYING";
      const fromStatus = this.requireTicket(waveId, ticketId).status;
      if (fromStatus === "PENDING") {
        assertTicketTransition(fromStatus, "CLAIMED", live.cancelRequested);
        const t = this.requireTicket(waveId, ticketId);
        t.status = "CLAIMED";
        t.revision += 1;
        this.db.putTicket(t);
      }
      const t2 = this.requireTicket(waveId, ticketId);
      assertTicketTransition(t2.status, nextStatus, live.cancelRequested);
      t2.status = nextStatus;
      t2.stage = stage;
      t2.owner = TICKET_OWNERS[nextStatus];
      t2.nextAction = TICKET_NEXT[nextStatus];
      t2.revision += 1;
      this.db.putTicket(t2);
      this.db.putStage({
        stageRunId,
        waveId,
        ticketId,
        stage,
        attempt,
        idempotencyKey,
        model: ticket.model,
        provider,
        status: "PENDING",
        createdAt: now,
      });
      this.db.putBudget({
        budgetId,
        waveId,
        stageRunId,
        tokensReserved: ceiling.tokens,
        costReservedMicros: ceiling.costMicros,
        state: "RESERVED",
        createdAt: now,
        updatedAt: now,
      });
      this.db.putOutbox({
        outboxId,
        waveId,
        ticketId,
        stage,
        attempt,
        idempotencyKey,
        state: "PENDING",
        fencingGeneration: this.db.getLease(repoWriterKey(live.repoPath))?.generation ?? 1,
        createdAt: now,
        updatedAt: now,
      });
      live.counters.launches += 1;
      this.db.putWave(live);
      this.refreshCounters(waveId);
    });

    if (this.crashAt === "after_reservation") {
      throw new CrashInjectedError("after_reservation");
    }
  }

  private async dispatchPending(waveId: string): Promise<void> {
    const pending = this.db.listOutbox(waveId).filter((item) => item.state === "PENDING");
    for (const item of pending) {
      this.db.transaction(() => {
        const current = this.db.getOutboxByIdempotency(item.idempotencyKey);
        if (!current || current.state !== "PENDING") return;
        this.db.putOutbox(claimOutbox(current, this.process.holder, this.clock.now()));
      });
      const claimed = this.db.getOutboxByIdempotency(item.idempotencyKey);
      if (!claimed) continue;
      if (this.requireWave(waveId).cancelRequested) {
        this.db.transaction(() => {
          const row = this.db.getOutboxByIdempotency(claimed.idempotencyKey);
          if (row && row.state !== "SETTLED") {
            this.db.putOutbox(markFailed(row, "cancelled before launch", this.clock.now()));
          }
        });
        continue;
      }
      if (claimed.stage === "PLAN" || claimed.stage === "IMPL") {
        const ticket = this.requireTicket(waveId, claimed.ticketId);
        if (!ticket.implWorktree) {
          const wave = this.requireWave(waveId);
          const created = await this.workspace.createImplWorktree({
            repoPath: wave.repoPath,
            baseSha: wave.baseSha,
            waveId,
            ticketId: claimed.ticketId,
            worktreeRoot: this.worktreeRoot ?? `${wave.repoPath}/tmp/wave-runner/worktrees`,
          });
          this.db.transaction(() => {
            const t = this.requireTicket(waveId, claimed.ticketId);
            t.implWorktree = created.worktree;
            t.implBranch = created.branch;
            this.db.putTicket(t);
          });
        }
      }
      if (this.crashAt === "after_launch" || this.crashAt === "before_receipt_commit") {
        await this.worker.launch(this.intentFromOutbox(claimed));
        throw new CrashInjectedError(this.crashAt);
      }
      const receipt = await this.worker.launch(this.intentFromOutbox(claimed));
      if (this.requireWave(waveId).flowId) {
        await this.workflow.linkStageTask({
          flowId: this.requireWave(waveId).flowId!,
          sourceId: claimed.idempotencyKey,
          label: `${claimed.stage}:${claimed.ticketId}`,
          task: `${claimed.stage} ${claimed.ticketId}`,
          childSessionKey: receipt.sessionId ?? claimed.idempotencyKey,
          runId: receipt.runId ?? claimed.idempotencyKey,
          runtime: receipt.provider === "openclaw-native" ? "subagent" : "acp",
        });
      }
      this.db.transaction(() => {
        const row = this.db.getOutboxByIdempotency(claimed.idempotencyKey);
        if (!row) return;
        this.db.putOutbox(markLaunched(row, JSON.stringify(receipt), this.clock.now()));
        const stage = this.db.getStageByIdempotency(claimed.idempotencyKey);
        if (stage) {
          stage.status = "RUNNING";
          stage.taskId = receipt.taskId;
          stage.runId = receipt.runId;
          stage.sessionId = receipt.sessionId;
          stage.provider = receipt.provider ?? stage.provider;
          stage.model = receipt.model ?? stage.model;
          stage.receiptJson = JSON.stringify(receipt);
          this.db.putStage(stage);
        }
      });
    }
  }

  private async observeLaunched(waveId: string): Promise<void> {
    const launched = this.db.listOutbox(waveId).filter((item) => item.state === "LAUNCHED");
    for (const item of launched) {
      const receipt = item.receiptJson
        ? (JSON.parse(item.receiptJson) as LaunchReceipt)
        : { idempotencyKey: item.idempotencyKey };
      const truth = await this.worker.inspect(receipt);
      if (truth.status === "succeeded" || truth.status === "failed" || truth.status === "cancelled") {
        if (this.crashAt === "after_completion" || this.crashAt === "before_settlement") {
          throw new CrashInjectedError(this.crashAt);
        }
        await this.settleOutbox(item, receipt, truth.status, truth.outputRef, truth.summary);
      }
    }
  }

  private async settleOutbox(
    item: LaunchOutbox,
    receipt: LaunchReceipt,
    status: "succeeded" | "failed" | "cancelled",
    outputRef?: string,
    summary?: string,
  ): Promise<void> {
    const usage = await this.usage.settle(receipt);
    const waveId = item.waveId;
    let planPath: string | undefined;
    if (item.stage === "PLAN" && status === "succeeded") {
      const ticket = this.requireTicket(waveId, item.ticketId);
      const planText = readActualPlanText({
        ticketId: item.ticketId,
        planClass: ticket.planClass,
        summary,
        outputRef,
        outputDir: receipt.outputDir,
      });
      planPath = await this.workspace.writePlanArtifact({
        repoPath: this.requireWave(waveId).repoPath,
        waveId,
        ticketId: item.ticketId,
        contents: planText,
        ...(this.artifactRoot ? { artifactRoot: this.artifactRoot } : {}),
      });
      summary = planText;
    }
    let verifyProof: string | undefined;
    if (item.stage === "IMPL" && status === "succeeded") {
      const ticket = this.requireTicket(waveId, item.ticketId);
      const worktree = ticket.implWorktree;
      if (worktree) {
        const verify = await this.workspace.verify({
          worktree,
          command: ticket.verifyCommand ?? "true",
        });
        verifyProof = verify.proof;
        if (!verify.ok) status = "failed";
      }
    }

    this.db.transaction(() => {
      const now = this.clock.now();
      const row = this.db.getOutboxByIdempotency(item.idempotencyKey);
      if (!row || row.state === "SETTLED") return;
      this.db.putOutbox(markSettled(row, now));
      const stage = this.db.getStageByIdempotency(item.idempotencyKey);
      if (stage) {
        stage.status = status === "succeeded" ? "SUCCEEDED" : status === "cancelled" ? "CANCELLED" : "FAILED";
        stage.outputRef = outputRef;
        this.db.putStage(stage);
        const budget = this.db.listBudgets(waveId).find((b) => b.stageRunId === stage.stageRunId);
        if (budget) {
          if (usage.kind === "actual") {
            this.db.putBudget(applySettlement(budget, usage.tokens, usage.costMicros, now));
          } else {
            this.db.putBudget(markIndeterminate(budget, now));
          }
        }
      }
      const ticket = this.requireTicket(waveId, item.ticketId);
      const wave = this.requireWave(waveId);
      if (status !== "succeeded") {
        ticket.status = status === "cancelled" ? "CANCELLED" : "FAILED";
        ticket.result = summary ?? status;
        ticket.revision += 1;
        this.db.putTicket(ticket);
      } else if (item.stage === "PLAN") {
        ticket.status = "PLAN_REVIEW";
        ticket.planArtifact = planPath;
        ticket.owner = TICKET_OWNERS.PLAN_REVIEW;
        ticket.nextAction = TICKET_NEXT.PLAN_REVIEW;
        ticket.revision += 1;
        this.db.putTicket(ticket);
        const decision = this.policy.decide({
          planClass: ticket.planClass,
          planText: summary ?? "",
        });
        if (decision === "wait") {
          wave.status = "WAITING_APPROVAL";
          wave.owner = WAVE_OWNERS.WAITING_APPROVAL;
          wave.nextAction = WAVE_NEXT.WAITING_APPROVAL;
          wave.revision += 1;
          wave.updatedAt = now;
          this.db.putWave(wave);
        } else {
          ticket.status = "APPROVED";
          ticket.owner = TICKET_OWNERS.APPROVED;
          ticket.nextAction = TICKET_NEXT.APPROVED;
          ticket.revision += 1;
          this.db.putTicket(ticket);
        }
      } else if (item.stage === "IMPL") {
        ticket.status = "VERIFYING";
        ticket.verifyProof = verifyProof;
        ticket.owner = TICKET_OWNERS.VERIFYING;
        ticket.nextAction = TICKET_NEXT.VERIFYING;
        ticket.revision += 1;
        this.db.putTicket(ticket);
        ticket.status = "DONE";
        ticket.result = "verified";
        ticket.owner = TICKET_OWNERS.DONE;
        ticket.nextAction = TICKET_NEXT.DONE;
        ticket.revision += 1;
        this.db.putTicket(ticket);
        const lease = this.db.getLease(repoWriterKey(wave.repoPath));
        if (lease && lease.ticketId === ticket.ticketId) {
          releaseLease({
            current: lease,
            claimant: this.process,
            expectedGeneration: lease.generation,
            now,
          });
          this.db.deleteLease(lease.resourceKey);
        }
      }
      if (planPath) {
        this.db.putArtifact({
          artifactId: `${waveId}:art:${randomUUID()}`,
          waveId,
          ticketId: item.ticketId,
          kind: "plan",
          path: planPath,
          hash: hashJson(planPath),
          createdAt: now,
        });
      }
      if (verifyProof) {
        this.db.putArtifact({
          artifactId: `${waveId}:art:${randomUUID()}`,
          waveId,
          ticketId: item.ticketId,
          kind: "proof",
          path: verifyProof,
          hash: hashJson(verifyProof),
          createdAt: now,
        });
      }
      this.refreshCounters(waveId);
    });

    const ticket = this.db.getTicket(waveId, item.ticketId);
    if (ticket && !this.disableSourceMirror) {
      try {
        await this.tracker.mirror({
          ticketId: ticket.ticketId,
          status: ticket.status,
          phase: ticket.stage,
          waveId,
          plan: ticket.planArtifact,
          workerOutDir: ticket.implWorktree,
          result: ticket.result,
          proof: ticket.verifyProof,
        });
      } catch {
        // Projection failure must not roll back durable state.
      }
    }
    if (this.requireWave(waveId).status === "WAITING_APPROVAL" && this.requireWave(waveId).flowId) {
      const live = this.requireWave(waveId);
      try {
        await this.workflow.waitForApproval({
          flowId: live.flowId!,
          expectedRevision: 0,
          currentStep: "await-operator-approval",
          stateJson: { waveId, ticketId: item.ticketId },
          waitJson: { kind: "operator-approval", ticketId: item.ticketId },
        });
      } catch {
        // Workflow projection is non-authoritative.
      }
    }
  }

  private maybeCompleteWave(waveId: string): void {
    this.db.transaction(() => {
      const wave = this.requireWave(waveId);
      if (isTerminalWave(wave.status)) return;
      const tickets = this.db.listTickets(waveId);
      if (tickets.length === 0) return;
      if (!tickets.every((t) => isTerminalTicket(t.status))) return;
      const budgets = this.db.listBudgets(waveId);
      assertBudgetStatesForTerminal(budgets);
      const failed = tickets.some((t) => t.status === "FAILED" || t.status === "BLOCKED" || t.status === "BUDGET_STOPPED");
      const cancelled = tickets.every((t) => t.status === "CANCELLED");
      wave.status = cancelled ? "CANCELLED" : failed ? "FAILED" : "COMPLETED";
      wave.owner = WAVE_OWNERS[wave.status];
      wave.nextAction = WAVE_NEXT[wave.status];
      wave.revision += 1;
      wave.updatedAt = this.clock.now();
      this.db.putWave(wave);
    });
  }

  private intentFromOutbox(item: LaunchOutbox): LaunchIntent {
    const ticket = this.requireTicket(item.waveId, item.ticketId);
    const root = ticket.implWorktree ?? this.artifactRoot ?? this.worktreeRoot ?? ".";
    const outputDir = stageAttemptDir({
      root,
      waveId: item.waveId,
      ticketId: item.ticketId,
      stage: item.stage,
      attempt: item.attempt,
    });
    return {
      idempotencyKey: item.idempotencyKey,
      waveId: item.waveId,
      ticketId: item.ticketId,
      stage: item.stage,
      attempt: item.attempt,
      prompt: `${item.stage} ${item.ticketId} ${ticket.title}`,
      sessionKey: stageSessionKey({
        waveId: item.waveId,
        ticketId: item.ticketId,
        stage: item.stage,
        attempt: item.attempt,
      }),
      worktree: ticket.implWorktree,
      outputDir,
      approvedPlanPath: item.stage === "PLAN" ? undefined : ticket.planArtifact,
      provider: ticket.provider,
      model: ticket.model,
    };
  }
}

function readActualPlanText(input: {
  ticketId: string;
  planClass?: string;
  summary?: string;
  outputRef?: string;
  outputDir?: string;
}): string {
  const candidates: string[] = [];
  if (input.outputDir) {
    candidates.push(join(input.outputDir, "PLAN.md"));
  }
  if (input.outputRef && existsSync(input.outputRef)) {
    try {
      const stat = statSync(input.outputRef);
      if (stat.isFile() && input.outputRef.endsWith("PLAN.md")) {
        candidates.push(input.outputRef);
      } else if (stat.isDirectory() && input.outputDir && input.outputRef === input.outputDir) {
        candidates.push(join(input.outputRef, "PLAN.md"));
      }
    } catch {
      // Never fall back to another stage's PLAN.md.
    }
  }
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, "utf8").trim();
      if (text) return text;
    } catch {
      // Try the next candidate.
    }
  }
  return `# PLAN ${input.ticketId}

${input.summary ?? "deterministic plan"}

class: ${input.planClass ?? "manual"}
`;
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
