import type { JsonValue } from "../domain/types.js";
import type { BoundManagedFlows, NativeSubagent, WaveRunnerPorts } from "../contracts.js";
import type {
  ApprovalWait,
  FlowRef,
  FrozenWave,
  LaunchIntent,
  StageTaskIntent,
  TaskRef,
  WorkerAdapter,
  WorkflowBackend,
} from "./ports.js";

export class ManagedTaskFlowBackend implements WorkflowBackend {
  constructor(private readonly flows: BoundManagedFlows) {}

  async createWave(input: FrozenWave): Promise<FlowRef> {
    const flow = this.flows.createManaged({
      controllerId: "wave-runner/v0",
      goal: input.goal,
      status: "running",
      notifyPolicy: "silent",
      currentStep: "wave-running",
      stateJson: input.stateJson,
    });
    return { flowId: flow.flowId, revision: flow.revision };
  }

  async linkStageTask(input: StageTaskIntent): Promise<TaskRef> {
    const linked = this.flows.runTask({
      flowId: input.flowId,
      runtime: input.runtime ?? "acp",
      sourceId: input.sourceId,
      childSessionKey: input.childSessionKey,
      runId: input.runId,
      label: input.label,
      task: input.task,
      preferMetadata: true,
      notifyPolicy: "silent",
      status: "running",
      startedAt: Date.now(),
      progressSummary: input.label,
    });
    if (!linked.created) {
      throw new Error(linked.reason);
    }
    return {
      taskId: linked.task.taskId,
      runId: linked.task.runId,
      sessionId: linked.task.childSessionKey,
    };
  }

  async waitForApproval(input: ApprovalWait): Promise<void> {
    const result = this.flows.setWaiting({
      flowId: input.flowId,
      expectedRevision: input.expectedRevision,
      currentStep: input.currentStep,
      stateJson: input.stateJson,
      waitJson: input.waitJson,
    });
    if (!result.applied && result.code !== "revision_conflict") {
      throw new Error(`waitForApproval failed: ${result.code}`);
    }
  }

  async resumeWave(input: {
    flowId: string;
    expectedRevision: number;
    stateJson: JsonValue;
  }): Promise<FlowRef> {
    const result = this.flows.resume({
      flowId: input.flowId,
      expectedRevision: input.expectedRevision,
      status: "running",
      stateJson: input.stateJson,
    });
    if (!result.applied) {
      throw new Error(`resume failed: ${result.code}`);
    }
    return { flowId: result.flow.flowId, revision: result.flow.revision };
  }

  async finishWave(result: {
    flowId: string;
    expectedRevision: number;
    stateJson: JsonValue;
  }): Promise<void> {
    const finished = this.flows.finish({
      flowId: result.flowId,
      expectedRevision: result.expectedRevision,
      stateJson: result.stateJson,
    });
    if (!finished.applied) {
      throw new Error(`finish failed: ${finished.code}`);
    }
  }

  async cancelWave(flowId: string): Promise<void> {
    await this.flows.cancel({ flowId, cfg: {} });
  }
}

export function boundedNativePrompt(intent: LaunchIntent): string {
  const isolated = intent.worktree
    ? `Isolated worktree only: ${intent.worktree}.`
    : "Do not touch any checkout.";
  return [
    intent.prompt,
    isolated,
    "Reply with exactly WAVE_RUNNER_P5_CHILD_OK and stop.",
    "Do not use tools, files, network, or other repositories.",
    "No deploy, push, merge, or Gateway changes.",
  ].join("\n");
}

export class NativeSubagentWorker implements WorkerAdapter {
  readonly kind = "native-subagent";
  private readonly receipts = new Map<string, { idempotencyKey: string; runId?: string; sessionId?: string; provider?: string; model?: string }>();

  constructor(private readonly subagent: NativeSubagent) {}

  async launch(intent: LaunchIntent) {
    const existing = this.receipts.get(intent.idempotencyKey);
    if (existing) return existing;
    const { runId } = await this.subagent.run({
      sessionKey: intent.sessionKey,
      message: boundedNativePrompt(intent),
      deliver: false,
      lightContext: true,
      idempotencyKey: intent.idempotencyKey,
      ...(intent.worktree ? { cwd: intent.worktree } : {}),
      ...(intent.provider ? { provider: intent.provider } : {}),
      ...(intent.model ? { model: intent.model } : {}),
    });
    const receipt = {
      idempotencyKey: intent.idempotencyKey,
      runId,
      sessionId: intent.sessionKey,
      provider: intent.provider ?? "openclaw-native",
      model: intent.model,
    };
    this.receipts.set(intent.idempotencyKey, receipt);
    return receipt;
  }

  async recover(intent: LaunchIntent) {
    return this.receipts.get(intent.idempotencyKey);
  }

  async inspect(receipt: { idempotencyKey: string; runId?: string }) {
    if (!receipt.runId) return { status: "unknown" as const };
    const wait = await this.subagent.waitForRun({ runId: receipt.runId, timeoutMs: 1 });
    if (wait.status === "timeout") return { status: "running" as const };
    if (wait.status === "ok") return { status: "succeeded" as const, summary: "native child terminal" };
    return { status: "failed" as const, error: wait.error };
  }

  async cancel() {
    return { cancelled: false, reason: "native cancel is flow-owned" };
  }
}

export function workflowFromPorts(ports: WaveRunnerPorts): ManagedTaskFlowBackend {
  return new ManagedTaskFlowBackend(ports.flows);
}
