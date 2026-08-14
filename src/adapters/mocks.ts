import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { hashTicketContent, normalizeSelectedDependencies } from "../core/manifest.js";
import type {
  FrozenTicket,
  JsonValue,
  LaunchReceipt,
  TicketSelector,
} from "../domain/types.js";
import type {
  ApprovalWait,
  FlowRef,
  FrozenWave,
  LaunchIntent,
  PolicyAdapter,
  StageTaskIntent,
  TaskRef,
  TrackerAdapter,
  TicketProjection,
  UsageAdapter,
  WorkerAdapter,
  WorkflowBackend,
  WorkspaceAdapter,
  WorktreeSpec,
} from "./ports.js";

export class MockTracker implements TrackerAdapter {
  readonly tickets = new Map<string, FrozenTicket & { body: string; status: string }>();
  readonly mirrors: TicketProjection[] = [];

  seed(ticket: FrozenTicket & { body?: string; status?: string }): void {
    const body = ticket.body ?? ticket.title;
    this.tickets.set(ticket.ticketId, {
      ...ticket,
      contentHash: ticket.contentHash || hashTicketContent({
        ticketId: ticket.ticketId,
        title: ticket.title,
        body,
        dependsOn: ticket.dependsOn,
        sourcePath: ticket.sourcePath,
      }),
      body,
      status: ticket.status ?? "open",
    });
  }

  async snapshot(selection: TicketSelector): Promise<FrozenTicket[]> {
    const selected = selection.ticketIds.map((id, index) => {
      const found = this.tickets.get(id);
      if (!found) {
        throw new Error(`Unknown ticket ${id}`);
      }
      const { body: _body, status: _status, ...frozen } = found;
      return { ...frozen, order: frozen.order || index + 1 };
    });
    return normalizeSelectedDependencies(
      selected,
      [...this.tickets.values()].map((ticket) => ({
        ticketId: ticket.ticketId,
        status: ticket.status,
      })),
    );
  }

  async mirror(update: TicketProjection): Promise<void> {
    this.mirrors.push(update);
  }
}

export class MockWorkflow implements WorkflowBackend {
  flows = new Map<string, { revision: number; status: string; stateJson?: JsonValue; waitJson?: JsonValue }>();
  tasks: TaskRef[] = [];
  runtimes: Array<"subagent" | "acp"> = [];
  cancelled: string[] = [];
  private n = 0;

  async createWave(input: FrozenWave): Promise<FlowRef> {
    const flowId = `flow-${++this.n}`;
    this.flows.set(flowId, { revision: 0, status: "running", stateJson: input.stateJson });
    return { flowId, revision: 0 };
  }

  async linkStageTask(input: StageTaskIntent): Promise<TaskRef> {
    this.runtimes.push(input.runtime ?? "acp");
    const ref = { taskId: `task-${this.tasks.length + 1}`, runId: input.runId, sessionId: input.childSessionKey };
    this.tasks.push(ref);
    return ref;
  }

  async waitForApproval(input: ApprovalWait): Promise<void> {
    const flow = this.flows.get(input.flowId);
    if (!flow) throw new Error("flow not found");
    flow.revision += 1;
    flow.status = "waiting";
    flow.stateJson = input.stateJson;
    flow.waitJson = input.waitJson;
  }

  async resumeWave(input: { flowId: string; expectedRevision: number; stateJson: JsonValue }): Promise<FlowRef> {
    const flow = this.flows.get(input.flowId);
    if (!flow) throw new Error("flow not found");
    if (flow.revision !== input.expectedRevision) {
      throw new Error(`revision conflict ${input.expectedRevision} != ${flow.revision}`);
    }
    flow.revision += 1;
    flow.status = "running";
    flow.stateJson = input.stateJson;
    flow.waitJson = undefined;
    return { flowId: input.flowId, revision: flow.revision };
  }

  async finishWave(result: { flowId: string; expectedRevision: number; stateJson: JsonValue }): Promise<void> {
    const flow = this.flows.get(result.flowId);
    if (!flow) throw new Error("flow not found");
    flow.revision += 1;
    flow.status = "succeeded";
    flow.stateJson = result.stateJson;
  }

  async cancelWave(flowId: string): Promise<void> {
    this.cancelled.push(flowId);
    const flow = this.flows.get(flowId);
    if (flow) flow.status = "cancelled";
  }
}

export class MockWorker implements WorkerAdapter {
  launches = 0;
  readonly intents: LaunchIntent[] = [];
  readonly byKey = new Map<string, { receipt: LaunchReceipt; status: "running" | "succeeded" | "failed" | "cancelled"; output?: string }>();
  failNext = false;
  completeOnInspect = true;

  async launch(intent: LaunchIntent): Promise<LaunchReceipt> {
    this.intents.push(intent);
    const existing = this.byKey.get(intent.idempotencyKey);
    if (existing) return existing.receipt;
    this.launches += 1;
    const receipt: LaunchReceipt = {
      idempotencyKey: intent.idempotencyKey,
      taskId: `task-${intent.idempotencyKey}`,
      runId: `run-${intent.idempotencyKey}`,
      sessionId: intent.sessionKey,
      provider: intent.provider ?? "mock",
      model: intent.model ?? "mock-0",
    };
    this.byKey.set(intent.idempotencyKey, {
      receipt,
      status: this.failNext ? "failed" : "running",
      output: `${intent.stage} ${intent.ticketId}`,
    });
    this.failNext = false;
    return receipt;
  }

  async recover(intent: LaunchIntent): Promise<LaunchReceipt | undefined> {
    return this.byKey.get(intent.idempotencyKey)?.receipt;
  }

  async inspect(receipt: LaunchReceipt): Promise<{
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "lost" | "unknown";
    outputRef?: string;
    summary?: string;
  }> {
    const row = this.byKey.get(receipt.idempotencyKey);
    if (!row) return { status: "unknown" };
    if (row.status === "running" && this.completeOnInspect) {
      row.status = "succeeded";
    }
    return {
      status: row.status,
      outputRef: `mock://${receipt.idempotencyKey}`,
      summary: row.output,
    };
  }

  async cancel(receipt: LaunchReceipt): Promise<{ cancelled: boolean }> {
    const row = this.byKey.get(receipt.idempotencyKey);
    if (row && (row.status === "running")) {
      row.status = "cancelled";
      return { cancelled: true };
    }
    return { cancelled: false };
  }
}

export class MockUsage implements UsageAdapter {
  mode: "actual" | "indeterminate" = "indeterminate";
  actualTokens = 100;
  actualCostMicros = 0;

  async settle(_receipt: LaunchReceipt) {
    if (this.mode === "actual") {
      return { kind: "actual" as const, tokens: this.actualTokens, costMicros: this.actualCostMicros };
    }
    return { kind: "indeterminate" as const, reason: "public Task Run DTO has no provider usage" };
  }
}

export class MockWorkspace implements WorkspaceAdapter {
  primaryIsDirty = false;
  heads = new Map<string, string>();
  worktrees: string[] = [];
  verifies = 0;

  async currentHead(repoPath: string): Promise<string> {
    return this.heads.get(repoPath) ?? "base-sha-fixture";
  }

  async createImplWorktree(spec: WorktreeSpec): Promise<{ worktree: string; branch: string }> {
    const worktree = join(spec.worktreeRoot, spec.waveId, spec.ticketId);
    const branch = `wave/${spec.waveId}/${spec.ticketId}`;
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, "WORKTREE"), `${spec.baseSha}\n`, "utf8");
    this.worktrees.push(worktree);
    return { worktree, branch };
  }

  async writePlanArtifact(input: {
    repoPath: string;
    waveId: string;
    ticketId: string;
    contents: string;
    artifactRoot?: string;
  }): Promise<string> {
    const path = join(
      input.artifactRoot ?? input.repoPath,
      "tmp",
      "wave-runner",
      input.waveId,
      input.ticketId,
      "PLAN.md",
    );
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, input.contents, "utf8");
    return path;
  }

  async verify(input: { worktree: string; command: string }): Promise<{ ok: boolean; proof: string }> {
    this.verifies += 1;
    const ok = input.command !== "false";
    const proof = join(input.worktree, "VERIFY.json");
    writeFileSync(proof, JSON.stringify({ ok, command: input.command }), "utf8");
    return { ok, proof };
  }

  async recordProof(input: { worktree: string; ticketId: string; proof: string }): Promise<string> {
    const path = join(input.worktree, "PROOF.md");
    writeFileSync(path, `# ${input.ticketId}\n\n${input.proof}\n`, "utf8");
    return path;
  }

  async primaryDirty(_repoPath: string): Promise<boolean> {
    return this.primaryIsDirty;
  }
}

export class SafePolicy implements PolicyAdapter {
  safeClasses = new Set(["docs-only", "safe-policy", "deterministic-fixture"]);

  decide(input: { planClass?: string; planText: string }) {
    if (input.planClass && this.safeClasses.has(input.planClass)) return "auto-approve";
    if (/\bSAFE_POLICY_CLASS\b/.test(input.planText)) return "auto-approve";
    return "wait";
  }
}

export function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
