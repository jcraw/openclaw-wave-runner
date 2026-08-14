export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type FlowStatus =
  | "queued"
  | "running"
  | "waiting"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "lost";

export type TaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "lost";

export type FlowRecord = {
  flowId: string;
  revision: number;
  status: FlowStatus;
  goal: string;
  currentStep?: string;
  stateJson?: JsonValue;
  waitJson?: JsonValue;
  cancelRequestedAt?: number;
};

export type TaskRecord = {
  taskId: string;
  runId?: string;
  childSessionKey?: string;
  sourceId?: string;
  runtime?: "subagent" | "acp" | "cli" | "cron";
  status: TaskStatus;
  terminalSummary?: string;
  error?: string;
};

export type MutationResult =
  | { applied: true; flow: FlowRecord }
  | {
      applied: false;
      code: "not_found" | "not_managed" | "revision_conflict" | "persist_failed";
      current?: FlowRecord;
    };

export type TaskLinkResult =
  | { created: true; flow: FlowRecord; task: TaskRecord }
  | { created: false; found: boolean; reason: string; flow?: FlowRecord };

export interface BoundManagedFlows {
  createManaged(input: {
    controllerId: string;
    goal: string;
    status?: FlowStatus;
    notifyPolicy?: "done_only" | "state_changes" | "silent";
    currentStep?: string | null;
    stateJson?: JsonValue | null;
    waitJson?: JsonValue | null;
  }): FlowRecord;
  get(flowId: string): FlowRecord | undefined;
  list(): FlowRecord[];
  setWaiting(input: {
    flowId: string;
    expectedRevision: number;
    currentStep?: string | null;
    stateJson?: JsonValue | null;
    waitJson?: JsonValue | null;
  }): MutationResult;
  resume(input: {
    flowId: string;
    expectedRevision: number;
    status?: "queued" | "running";
    currentStep?: string | null;
    stateJson?: JsonValue | null;
  }): MutationResult;
  finish(input: {
    flowId: string;
    expectedRevision: number;
    stateJson?: JsonValue | null;
  }): MutationResult;
  cancel(input: {
    flowId: string;
    cfg: unknown;
  }): Promise<{
    found: boolean;
    cancelled: boolean;
    reason?: string;
    flow?: FlowRecord;
    tasks?: TaskRecord[];
  }>;
  runTask(input: {
    flowId: string;
    runtime: "subagent" | "acp";
    sourceId: string;
    childSessionKey: string;
    runId: string;
    label: string;
    task: string;
    preferMetadata: boolean;
    notifyPolicy: "silent";
    status: "running";
    startedAt: number;
    progressSummary: string;
  }): TaskLinkResult;
}

export interface ReadOnlyTasks {
  get(taskId: string): TaskRecord | undefined;
  findBySourceId?(sourceId: string): TaskRecord | undefined;
  findByRunId?(runId: string): TaskRecord | undefined;
  findBySessionKey?(childSessionKey: string): TaskRecord | undefined;
}

export interface NativeSubagent {
  run(input: {
    sessionKey: string;
    message: string;
    deliver: false;
    lightContext: true;
    idempotencyKey: string;
    cwd?: string;
    provider?: string;
    model?: string;
  }): Promise<{ runId: string }>;
  waitForRun(input: {
    runId: string;
    timeoutMs: number;
  }): Promise<{ status: "ok" | "error" | "timeout"; error?: string }>;
}

export interface WaveRunnerPorts {
  config: unknown;
  now(): number;
  flows: BoundManagedFlows;
  tasks: ReadOnlyTasks;
  subagent: NativeSubagent;
  /** Public ACP spawn port. Product workers fail closed when this is absent. */
  acp?: import("./adapters/ports.js").AcpSpawn;
}
