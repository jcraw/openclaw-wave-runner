import { randomUUID } from "node:crypto";

import type { Clock } from "../domain/clock.js";
import { SequentialIds } from "../domain/clock.js";
import { DuplicateEventError, WaveError } from "../domain/errors.js";
import type {
  FrozenManifest,
  LaunchMode,
  TicketRun,
  WaveRecord,
  WaveView,
} from "../domain/types.js";
import { WaveDatabase } from "../store/database.js";
import { countersFromBudgets } from "./budget.js";
import type { ProcessIdentity } from "./lease.js";
import type { OutboxBoundary } from "./outbox.js";
import type {
  PolicyAdapter,
  TrackerAdapter,
  UsageAdapter,
  WakePort,
  WorkerAdapter,
  WorkflowBackend,
  WorkspaceAdapter,
} from "./ports.js";
import { assertExpectedRevision } from "./state-machine.js";

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
  wake?: WakePort;
  process: ProcessIdentity;
  leaseTtlMs?: number;
  crashAt?: OutboxBoundary | null;
  llmCalls?: { count: number };
  worktreeRoot?: string;
  artifactRoot?: string;
  launchMode?: LaunchMode;
  disableSourceMirror?: boolean;
};

export type ControllerContext = {
  readonly db: WaveDatabase;
  readonly clock: Clock;
  readonly ids: SequentialIds;
  readonly tracker: TrackerAdapter;
  readonly workflow: WorkflowBackend;
  readonly worker: WorkerAdapter;
  readonly usage: UsageAdapter;
  readonly workspace: WorkspaceAdapter;
  readonly policy: PolicyAdapter;
  readonly wake?: WakePort;
  readonly process: ProcessIdentity;
  readonly leaseTtlMs: number;
  crashAt: OutboxBoundary | null;
  readonly llmCalls: { count: number };
  readonly worktreeRoot?: string;
  readonly artifactRoot?: string;
  readonly launchMode: LaunchMode;
  readonly disableSourceMirror: boolean;
  watchdogFires: number;
};

export function eventId(kind = "evt"): string {
  return `${kind}-${randomUUID()}`;
}

export function requireWave(ctrl: ControllerContext, waveId: string): WaveRecord {
  const wave = ctrl.db.getWave(waveId);
  if (!wave) throw new WaveError(`Wave not found: ${waveId}`, "not_found");
  return wave;
}

export function requireTicket(ctrl: ControllerContext, waveId: string, ticketId: string): TicketRun {
  const ticket = ctrl.db.getTicket(waveId, ticketId);
  if (!ticket) throw new WaveError(`Ticket ${ticketId} is not in wave ${waveId}.`, "not_found");
  return ticket;
}

export function recordEvent(
  ctrl: ControllerContext,
  eventId: string,
  waveId: string,
  type: string,
  payload: unknown,
): void {
  const inserted = ctrl.db.insertEvent({
    eventId,
    waveId,
    type,
    payloadJson: JSON.stringify(payload),
    createdAt: ctrl.clock.now(),
  });
  if (!inserted) {
    throw new DuplicateEventError(eventId);
  }
}

export function recordOrThrow(
  ctrl: ControllerContext,
  eventId: string,
  waveId: string,
  type: string,
  payload: unknown,
): void {
  ctrl.db.transaction(() => {
    recordEvent(ctrl, eventId, waveId, type, payload);
  });
}

export function inspect(ctrl: ControllerContext, waveId: string): WaveView {
  const wave = requireWave(ctrl, waveId);
  return {
    wave,
    manifest: JSON.parse(wave.manifestJson) as FrozenManifest,
    tickets: ctrl.db.listTickets(waveId),
    stages: ctrl.db.listStages(waveId),
    budgets: ctrl.db.listBudgets(waveId),
    outbox: ctrl.db.listOutbox(waveId),
    leases: ctrl.db.listLeases(waveId),
    events: ctrl.db.listEvents(waveId),
    artifacts: ctrl.db.listArtifacts(waveId),
  };
}

export function mutateWave(
  ctrl: ControllerContext,
  waveId: string,
  eventId: string,
  type: string,
  expectedRevision: number | undefined,
  mut: (wave: WaveRecord) => void,
): WaveView {
  ctrl.db.transaction(() => {
    recordEvent(ctrl, eventId, waveId, type, {});
    const wave = requireWave(ctrl, waveId);
    assertExpectedRevision(wave.revision, expectedRevision);
    mut(wave);
    wave.revision += 1;
    wave.updatedAt = ctrl.clock.now();
    ctrl.db.putWave(wave);
  });
  return inspect(ctrl, waveId);
}

export function refreshCounters(ctrl: ControllerContext, waveId: string): void {
  const wave = requireWave(ctrl, waveId);
  wave.counters = countersFromBudgets(
    ctrl.db.listBudgets(waveId),
    wave.counters.launches,
    wave.counters.startedAt,
  );
  ctrl.db.putWave(wave);
}
