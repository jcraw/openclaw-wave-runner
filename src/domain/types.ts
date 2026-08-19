export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type WaveStatus =
  | "DRAFT"
  | "FROZEN"
  | "RUNNING"
  | "AWAITING_PLAN_GATE"
  | "WAITING_APPROVAL"
  | "PAUSED"
  | "COMPLETED"
  | "BLOCKED"
  | "FAILED"
  | "BUDGET_STOPPED"
  | "CANCELLED";

export type TicketStatus =
  | "PENDING"
  | "CLAIMED"
  | "PLANNING"
  | "PLAN_REVIEW"
  | "APPROVED"
  | "REVISING"
  | "IMPLEMENTING"
  | "VERIFYING"
  | "DONE"
  | "BLOCKED"
  | "FAILED"
  | "BUDGET_STOPPED"
  | "CANCELLED";

export type StageName = "PLAN" | "IMPL" | "VERIFY";

export type BudgetState = "RESERVED" | "COMMITTED" | "INDETERMINATE" | "RELEASED";

export type OutboxState =
  | "PENDING"
  | "CLAIMED"
  | "LAUNCHED"
  | "RECONCILING"
  | "SETTLED"
  | "FAILED";

export type QuotaMode = "tokens" | "usd" | "quota";

export type WaveLimits = {
  maxTokens: number;
  maxCostMicros: number;
  maxLaunches: number;
  maxRetriesPerStage: number;
  maxWallTimeMs: number;
  repoConcurrency: 1;
  perProviderConcurrency: number;
  perStageReservationTokens: number;
  perStageReservationCostMicros: number;
};

export type WaveCounters = {
  committedTokens: number;
  reservedTokens: number;
  indeterminateTokens: number;
  committedCostMicros: number;
  reservedCostMicros: number;
  indeterminateCostMicros: number;
  launches: number;
  startedAt?: number;
};

export type SatisfiedExternalDep = {
  ticketId: string;
  status: string;
  reason: "already-done-external";
};

export type FrozenTicket = {
  ticketId: string;
  title: string;
  contentHash: string;
  dependsOn: string[];
  order: number;
  sourcePath: string;
  planClass?: string;
  verifyCommand?: string;
  provider?: string;
  model?: string;
  /** True when Jason/human must approve (needs_jason: true / human_gated). Omit = auto-continue after PLAN. */
  humanHold?: boolean;
  humanHoldReason?: "needs_jason" | "human_gated";
  /** Writer lease scope (WR-011). Disjoint scopes may IMPL in parallel. */
  writerScope?: string;
  product?: string;
  game?: string;
  satisfiedExternalDeps?: SatisfiedExternalDep[];
};

export type FrozenManifest = {
  schema: 1;
  waveId: string;
  repoPath: string;
  baseSha: string;
  tickets: FrozenTicket[];
  limits: WaveLimits;
  quotaMode: QuotaMode;
  stopAt?: number;
  deadlineMs?: number;
  createdAt: number;
  drainEverything: false;
  overnight: false;
  recurringLlmPolling: false;
  deployPush: false;
  productionDrain: false;
  operatorActionRequired: boolean;
  supervisedBoundedPilot: boolean;
  /** Compatibility marker for the already-proven one-ticket path. */
  supervisedOneTicket: boolean;
};

export type WaveRecord = {
  waveId: string;
  manifestJson: string;
  manifestHash: string;
  repoPath: string;
  baseSha: string;
  status: WaveStatus;
  revision: number;
  deadlineMs?: number;
  stopAt?: number;
  limits: WaveLimits;
  counters: WaveCounters;
  flowId?: string;
  owner: string;
  nextAction: string;
  createdAt: number;
  updatedAt: number;
  cancelRequested: boolean;
  quotaMode: QuotaMode;
};

export type TicketRun = {
  waveId: string;
  ticketId: string;
  contentHash: string;
  title: string;
  dependsOn: string[];
  order: number;
  sourcePath: string;
  stage: StageName | "NONE";
  status: TicketStatus;
  revision: number;
  owner: string;
  nextAction: string;
  planClass?: string;
  planArtifact?: string;
  implWorktree?: string;
  implBranch?: string;
  implSha?: string;
  verifyProof?: string;
  verifyCommand?: string;
  provider?: string;
  model?: string;
  humanHold?: boolean;
  humanHoldReason?: "needs_jason" | "human_gated";
  writerScope?: string;
  product?: string;
  game?: string;
  result?: string;
};

export type StageRun = {
  stageRunId: string;
  waveId: string;
  ticketId: string;
  stage: StageName;
  attempt: number;
  idempotencyKey: string;
  model?: string;
  provider?: string;
  taskId?: string;
  runId?: string;
  sessionId?: string;
  receiptJson?: string;
  outputRef?: string;
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  createdAt: number;
};

export type BudgetEntry = {
  budgetId: string;
  waveId: string;
  stageRunId?: string;
  tokensReserved: number;
  costReservedMicros: number;
  tokensActual?: number;
  costActualMicros?: number;
  state: BudgetState;
  createdAt: number;
  updatedAt: number;
};

export type LaunchOutbox = {
  outboxId: string;
  waveId: string;
  ticketId: string;
  stage: StageName;
  attempt: number;
  idempotencyKey: string;
  state: OutboxState;
  fencingGeneration: number;
  claimedBy?: string;
  claimedAt?: number;
  receiptJson?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

export type LeaseRecord = {
  resourceKey: string;
  generation: number;
  holder: string;
  waveId?: string;
  ticketId?: string;
  taskId?: string;
  processIdentity: string;
  pid?: number;
  pidStartTime?: string;
  expiresAt: number;
  createdAt: number;
};

export type DomainEvent = {
  eventId: string;
  waveId: string;
  type: string;
  payloadJson: string;
  createdAt: number;
  revisionApplied?: number;
};

export type ArtifactRecord = {
  artifactId: string;
  waveId: string;
  ticketId?: string;
  kind: string;
  path: string;
  hash?: string;
  createdAt: number;
};

export type TicketSelector = {
  ticketIds: string[];
  repoPath: string;
};

export type CreateWaveInput = {
  waveId: string;
  repoPath: string;
  ticketIds: string[];
  limits: WaveLimits;
  quotaMode?: QuotaMode;
  stopAt?: number;
  deadlineMs?: number;
  owner?: string;
  supervisedBoundedPilot?: boolean;
  supervisedOneTicket?: boolean;
  isolatedWorktreeRoot?: string;
  operatorAction?: boolean;
};

export type UsageActual = {
  kind: "actual";
  tokens: number;
  costMicros: number;
  providerResponseId?: string;
};

export type UsageIndeterminate = {
  kind: "indeterminate";
  reason: string;
};

export type UsageResult = UsageActual | UsageIndeterminate;

export type LaunchReceipt = {
  idempotencyKey: string;
  taskId?: string;
  runId?: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  /** Durable worker output directory. Required for inspect after process restart. */
  outputDir?: string;
};

export type WorkerTruth = {
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "lost" | "unknown";
  outputRef?: string;
  summary?: string;
  error?: string;
};

export type WaveView = {
  wave: WaveRecord;
  manifest: FrozenManifest;
  tickets: TicketRun[];
  stages: StageRun[];
  budgets: BudgetEntry[];
  outbox: LaunchOutbox[];
  leases: LeaseRecord[];
  events: DomainEvent[];
  artifacts: ArtifactRecord[];
};

export const TERMINAL_WAVE: ReadonlySet<WaveStatus> = new Set([
  "COMPLETED",
  "BLOCKED",
  "FAILED",
  "BUDGET_STOPPED",
  "CANCELLED",
]);

export const TERMINAL_TICKET: ReadonlySet<TicketStatus> = new Set([
  "DONE",
  "BLOCKED",
  "FAILED",
  "BUDGET_STOPPED",
  "CANCELLED",
]);

export const DEFAULT_LIMITS: WaveLimits = {
  // WR-012: drain-shaped defaults — orchestrator stays cheap; workers may run long.
  maxTokens: 500_000,
  maxCostMicros: 0,
  maxLaunches: 10,
  // Two automatic retries on empty/flaky worker death (WR-010/012).
  maxRetriesPerStage: 2,
  maxWallTimeMs: 0,
  repoConcurrency: 1,
  perProviderConcurrency: 5,
  // Reservation is admission headroom only; settle clears it (do not starve long IMPL).
  perStageReservationTokens: 8_000,
  perStageReservationCostMicros: 0,
};

export const SUPERVISED_PILOT_LIMITS: Readonly<WaveLimits> = Object.freeze({
  maxTokens: 500_000,
  maxCostMicros: 0,
  maxLaunches: 10,
  maxRetriesPerStage: 2,
  maxWallTimeMs: 0,
  // repoConcurrency stays 1 = one writer *per scope* (see writerLeaseKey).
  repoConcurrency: 1,
  // Align with OpenClaw acp.maxConcurrentSessions default (5).
  perProviderConcurrency: 5,
  perStageReservationTokens: 8_000,
  perStageReservationCostMicros: 0,
});

/** @deprecated use writerLeaseKey + deriveWriterScope (WR-011) */
export { repoWriterKey, writerLeaseKey, deriveWriterScope } from "./writer-scope.js";

export function providerKey(provider: string): string {
  return `provider:${provider}`;
}

export type LaunchMode = "mock" | "supervised-bounded" | "supervised-one-ticket";

export type SupervisedStartOptions = {
  supervisedBoundedPilot?: boolean;
  supervisedOneTicket?: boolean;
  operatorAction?: boolean;
};
