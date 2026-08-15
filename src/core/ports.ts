import type {
  FrozenTicket,
  JsonValue,
  LaunchReceipt,
  TicketSelector,
  UsageResult,
  WorkerTruth,
} from "../domain/types.js";

export type TicketProjection = {
  ticketId: string;
  status: string;
  phase?: string;
  waveId: string;
  plan?: string;
  workerOutDir?: string;
  result?: string;
  proof?: string;
};

export interface TrackerAdapter {
  snapshot(selection: TicketSelector): Promise<FrozenTicket[]>;
  mirror(update: TicketProjection): Promise<void>;
}

export type FlowRef = { flowId: string; revision: number };
export type TaskRef = { taskId: string; runId?: string; sessionId?: string };

export type FrozenWave = {
  waveId: string;
  manifestHash: string;
  goal: string;
  stateJson: JsonValue;
};

export type StageTaskRuntime = "subagent" | "acp";

export type StageTaskIntent = {
  flowId: string;
  sourceId: string;
  label: string;
  task: string;
  childSessionKey: string;
  runId: string;
  runtime?: StageTaskRuntime;
};

export type ApprovalWait = {
  flowId: string;
  expectedRevision: number;
  currentStep: string;
  stateJson: JsonValue;
  waitJson: JsonValue;
};

export type WaveResult = {
  flowId: string;
  expectedRevision: number;
  stateJson: JsonValue;
};

export interface WorkflowBackend {
  createWave(input: FrozenWave): Promise<FlowRef>;
  linkStageTask(input: StageTaskIntent): Promise<TaskRef>;
  waitForApproval(input: ApprovalWait): Promise<void>;
  resumeWave(input: { flowId: string; expectedRevision: number; stateJson: JsonValue }): Promise<FlowRef>;
  finishWave(result: WaveResult): Promise<void>;
  cancelWave(flowId: string): Promise<void>;
}

export type LaunchIntent = {
  idempotencyKey: string;
  waveId: string;
  ticketId: string;
  stage: "PLAN" | "IMPL" | "VERIFY";
  attempt?: number;
  prompt: string;
  sessionKey: string;
  worktree?: string;
  outputDir?: string;
  approvedPlanPath?: string;
  provider?: string;
  model?: string;
};

export type CancelResult = { cancelled: boolean; reason?: string };

export interface WorkerAdapter {
  launch(intent: LaunchIntent): Promise<LaunchReceipt>;
  inspect(receipt: LaunchReceipt): Promise<WorkerTruth>;
  recover(intent: LaunchIntent): Promise<LaunchReceipt | undefined>;
  cancel(receipt: LaunchReceipt): Promise<CancelResult>;
}

export interface UsageAdapter {
  settle(receipt: LaunchReceipt): Promise<UsageResult>;
}

export type WorktreeSpec = {
  repoPath: string;
  baseSha: string;
  waveId: string;
  ticketId: string;
  worktreeRoot: string;
};

export interface WorkspaceAdapter {
  currentHead(repoPath: string): Promise<string>;
  createImplWorktree(spec: WorktreeSpec): Promise<{ worktree: string; branch: string }>;
  writePlanArtifact(input: {
    repoPath: string;
    waveId: string;
    ticketId: string;
    contents: string;
    artifactRoot?: string;
  }): Promise<string>;
  verify(input: { worktree: string; command: string }): Promise<{ ok: boolean; proof: string }>;
  recordProof(input: { worktree: string; ticketId: string; proof: string }): Promise<string>;
  primaryDirty(repoPath: string): Promise<boolean>;
}

export type PolicyDecision = "auto-approve" | "wait";

export interface PolicyAdapter {
  decide(input: { planClass?: string; planText: string }): PolicyDecision;
}

export type PlanGateWake = {
  waveId: string;
  ticketId: string;
  planPath?: string;
  revision: number;
};

/** Host one-shot wake for agent plan-gate. Ledger event is authoritative; host emit is best-effort. */
export interface WakePort {
  emitOnce(wake: PlanGateWake): void | Promise<void>;
}
