import { SequentialIds } from "../domain/clock.js";
import type {
  CreateWaveInput,
  SupervisedStartOptions,
  WaveView,
} from "../domain/types.js";
import {
  CrashInjectedError,
  type ControllerOptions,
  eventId as nextEventId,
  inspect,
} from "./controller-context.js";
import { expireStaleLeases, reconcile } from "./launch.js";
import { runUntilIdle, tickWave } from "./tick.js";
import {
  approveWave,
  backupWave,
  cancelWave,
  emergencyStop,
  freezeWave,
  pauseWave,
  resumeWave,
  reviseWave,
  startWave,
} from "./wave-commands.js";
import { createWave, defaultCreateInput, dryRun } from "./wave-create.js";
import { capabilities, project } from "./wave-projection.js";

export { CrashInjectedError, type ControllerOptions };
export { defaultCreateInput };

export class WaveController {
  readonly db;
  readonly clock;
  readonly ids;
  readonly tracker;
  readonly workflow;
  readonly worker;
  readonly usage;
  readonly workspace;
  readonly policy;
  readonly wake;
  readonly process;
  readonly leaseTtlMs;
  crashAt;
  readonly llmCalls;
  readonly worktreeRoot;
  readonly artifactRoot;
  readonly launchMode;
  readonly disableSourceMirror;
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
    this.wake = opts.wake;
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
    return capabilities(this);
  }

  async dryRun(input: CreateWaveInput) {
    return dryRun(this, input);
  }

  async create(input: CreateWaveInput, eventId = nextEventId()): Promise<WaveView> {
    return createWave(this, input, eventId);
  }

  freeze(waveId: string, eventId = nextEventId(), expectedRevision?: number): WaveView {
    return freezeWave(this, waveId, eventId, expectedRevision);
  }

  async start(
    waveId: string,
    eventId = nextEventId(),
    expectedRevision?: number,
    options: SupervisedStartOptions = {},
  ): Promise<WaveView> {
    return startWave(this, waveId, eventId, expectedRevision, options);
  }

  pause(waveId: string, eventId = nextEventId(), expectedRevision?: number): WaveView {
    return pauseWave(this, waveId, eventId, expectedRevision);
  }

  resume(waveId: string, eventId = nextEventId(), expectedRevision?: number): WaveView {
    return resumeWave(this, waveId, eventId, expectedRevision);
  }

  cancel(waveId: string, eventId = nextEventId(), expectedRevision?: number): WaveView {
    return cancelWave(this, waveId, eventId, expectedRevision);
  }

  approve(
    waveId: string,
    ticketId: string,
    expectedTicketRevision: number,
    eventId = nextEventId(),
  ): WaveView {
    return approveWave(this, waveId, ticketId, expectedTicketRevision, eventId);
  }

  revise(waveId: string, ticketId: string, eventId = nextEventId()): WaveView {
    return reviseWave(this, waveId, ticketId, eventId);
  }

  inspect(waveId: string): WaveView {
    return inspect(this, waveId);
  }

  project() {
    return project(this);
  }

  async tick(waveId: string, options: SupervisedStartOptions = {}): Promise<WaveView> {
    return tickWave(this, waveId, options);
  }

  async runUntilIdle(
    waveId: string,
    maxSteps = 32,
    options: SupervisedStartOptions = {},
  ): Promise<WaveView> {
    return runUntilIdle(this, waveId, maxSteps, options);
  }

  async reconcile(waveId: string): Promise<void> {
    return reconcile(this, waveId);
  }

  expireStaleLeases(): number {
    return expireStaleLeases(this);
  }

  emergencyStop(reason = "operator emergency stop"): { stopped: string[] } {
    return emergencyStop(this, reason);
  }

  backup(destPath: string): { path: string; schemaVersion: number } {
    return backupWave(this, destPath);
  }
}
