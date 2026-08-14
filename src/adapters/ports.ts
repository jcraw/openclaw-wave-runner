import type { WorkerTruth } from "../domain/types.js";
import type { CancelResult } from "../core/ports.js";

export type {
  ApprovalWait,
  CancelResult,
  FlowRef,
  FrozenWave,
  LaunchIntent,
  PolicyDecision,
  StageTaskIntent,
  StageTaskRuntime,
  TaskRef,
  TicketProjection,
  WaveResult,
  WorktreeSpec,
} from "../core/ports.js";
export type {
  PolicyAdapter,
  TrackerAdapter,
  UsageAdapter,
  WorkerAdapter,
  WorkflowBackend,
  WorkspaceAdapter,
} from "../core/ports.js";

export type AcpSpawnRequest = {
  agentId: "grok";
  mode: "run";
  sessionKey: string;
  cwd?: string;
  task: string;
  sourceId: string;
  /** Optional only for ACP agents that implement runtime model switching. Grok is pinned in argv. */
  model?: string;
};

export type AcpSpawnResult = {
  runId: string;
  sessionId: string;
  taskId?: string;
};

export interface AcpSpawn {
  spawn(request: AcpSpawnRequest): Promise<AcpSpawnResult>;
  inspect(receipt: {
    runId?: string;
    taskId?: string;
    sessionId?: string;
    sourceId: string;
  }): Promise<WorkerTruth>;
  cancel(receipt: {
    runId?: string;
    taskId?: string;
    sessionId?: string;
    sourceId: string;
  }): Promise<CancelResult>;
  findBySourceId(sourceId: string): Promise<AcpSpawnResult | undefined>;
}
