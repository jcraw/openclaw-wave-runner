import { createHash } from "node:crypto";

import type { WorkerTruth } from "../domain/types.js";
import type {
  AcpSpawn,
  AcpSpawnRequest,
  AcpSpawnResult,
  CancelResult,
} from "./ports.js";

type GatewayRequest = <T = unknown>(
  method: string,
  params?: Record<string, unknown>,
  options?: { timeoutMs?: number },
) => Promise<T>;

type GatewayTask = {
  id?: string;
  taskId?: string;
  runtime?: string;
  status?: string;
  title?: string;
  sessionKey?: string;
  childSessionKey?: string;
  runId?: string;
  terminalSummary?: string;
  error?: string;
};

type TaskListResponse = {
  tasks?: GatewayTask[];
  nextCursor?: string;
};

type ToolInvokeResponse = {
  ok?: boolean;
  output?: unknown;
  error?: { code?: string; message?: string };
};

type SpawnToolResult = {
  status?: string;
  childSessionKey?: string;
  runId?: string;
  error?: string;
};

function recoveryLabel(sourceId: string): string {
  const digest = createHash("sha256").update(sourceId).digest("hex").slice(0, 32);
  return `wave-runner:${digest}`;
}

function parseToolJson(output: unknown): SpawnToolResult {
  if (!output || typeof output !== "object") {
    throw new Error("OpenClaw tools.invoke returned no sessions_spawn output.");
  }
  const direct = output as Record<string, unknown>;
  const details = direct.details;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    return details as SpawnToolResult;
  }
  const content = direct.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const text = (block as { text?: unknown }).text;
      if (typeof text !== "string") continue;
      try {
        const parsed = JSON.parse(text) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as SpawnToolResult;
        }
      } catch {
        // Keep looking for a structured JSON block.
      }
    }
  }
  throw new Error("OpenClaw sessions_spawn returned an unreadable tool result.");
}

function taskId(task: GatewayTask): string | undefined {
  return task.taskId?.trim() || task.id?.trim() || undefined;
}

function mapTaskTruth(task: GatewayTask): WorkerTruth {
  switch (task.status) {
    case "queued":
      return { status: "queued" };
    case "running":
      return { status: "running" };
    case "completed":
    case "succeeded":
      return { status: "succeeded", summary: task.terminalSummary };
    case "cancelled":
      return { status: "cancelled", summary: task.terminalSummary };
    case "failed":
      return { status: "failed", error: task.error ?? task.terminalSummary };
    case "timed_out":
      return { status: "failed", error: task.error ?? "ACP worker timed out." };
    case "lost":
      return { status: "lost", error: task.error ?? task.terminalSummary };
    default:
      return { status: "unknown", error: `Unknown OpenClaw task status: ${String(task.status)}` };
  }
}

/**
 * Public OpenClaw ACP lifecycle adapter.
 *
 * Spawning goes through the Gateway-visible sessions_spawn tool. Observation and
 * cancellation use the public task ledger RPCs. A short deterministic label is
 * attached to every spawn so crash recovery can adopt an already-registered ACP
 * task without launching a duplicate.
 */
export class OpenClawGatewayAcpSpawn implements AcpSpawn {
  constructor(
    private readonly request: GatewayRequest,
    private readonly requesterSessionKey: string,
    private readonly requesterAgentId = "main",
  ) {}

  async spawn(input: AcpSpawnRequest): Promise<AcpSpawnResult> {
    const label = recoveryLabel(input.sourceId);
    // Mona/Kawazaki/Robin are OpenClaw config agents → native subagent.
    // Grok builders stay on ACP harness (agentId "grok").
    // Codex ACP: never pass thinking. acpx rejects config key "thinking" when
    // that option is not advertised (RRT-113-115 wave fail). Pin bare Sol so
    // parent Grok model/thinking does not leak into the child session model id.
    const args: Record<string, unknown> = {
      task: input.task,
      runtime: input.agentId === "mona" ? "subagent" : "acp",
      agentId: input.agentId,
      mode: input.mode,
      cleanup: "keep",
      cwd: input.cwd,
      label,
      taskName: `wave-${label.slice("wave-runner:".length, "wave-runner:".length + 24)}`,
      // sessions_spawn rejects per-call timeoutSeconds. Host runTimeoutSeconds + WAVE_*_WALL_MS.
    };
    if (input.agentId === "codex") {
      const rawModel = input.model?.trim() ?? "";
      let bare = rawModel;
      if (bare.toLowerCase().startsWith("openai/")) bare = bare.slice(7);
      bare = bare.split("/")[0]?.trim() ?? "";
      args.model = bare && !/grok/i.test(bare) ? bare : "gpt-5.6-sol";
      // intentionally omit args.thinking
    } else if (input.model?.trim()) {
      args.model = input.model.trim();
    }
    const invoked = await this.request<ToolInvokeResponse>("tools.invoke", {
      name: "sessions_spawn",
      sessionKey: this.requesterSessionKey,
      agentId: this.requesterAgentId,
      idempotencyKey: label,
      args,
    });
    if (invoked.ok !== true) {
      throw new Error(invoked.error?.message ?? "OpenClaw refused the ACP sessions_spawn call.");
    }
    const result = parseToolJson(invoked.output);
    if (result.status !== "accepted" || !result.runId?.trim() || !result.childSessionKey?.trim()) {
      throw new Error(result.error ?? `OpenClaw ACP spawn was not accepted (${String(result.status)}).`);
    }
    const registered = await this.findTask({
      runId: result.runId,
      childSessionKey: result.childSessionKey,
      title: label,
    });
    return {
      runId: result.runId,
      sessionId: result.childSessionKey,
      taskId: registered ? taskId(registered) : undefined,
    };
  }

  async inspect(receipt: {
    runId?: string;
    taskId?: string;
    sessionId?: string;
    sourceId: string;
  }): Promise<WorkerTruth> {
    const task = receipt.taskId
      ? await this.getTask(receipt.taskId)
      : await this.findTask({
          runId: receipt.runId,
          childSessionKey: receipt.sessionId,
          title: recoveryLabel(receipt.sourceId),
        });
    return task ? mapTaskTruth(task) : { status: "unknown", error: "ACP task is absent from the public task ledger." };
  }

  async cancel(receipt: {
    runId?: string;
    taskId?: string;
    sessionId?: string;
    sourceId: string;
  }): Promise<CancelResult> {
    const task = receipt.taskId
      ? await this.getTask(receipt.taskId)
      : await this.findTask({
          runId: receipt.runId,
          childSessionKey: receipt.sessionId,
          title: recoveryLabel(receipt.sourceId),
        });
    const id = task && taskId(task);
    if (!id) return { cancelled: false, reason: "ACP task is absent from the public task ledger." };
    const result = await this.request<{ found?: boolean; cancelled?: boolean; reason?: string }>(
      "tasks.cancel",
      { taskId: id, reason: `Wave Runner cancelled ${receipt.sourceId}` },
    );
    return {
      cancelled: result.cancelled === true,
      reason: result.reason,
    };
  }

  async findBySourceId(sourceId: string): Promise<AcpSpawnResult | undefined> {
    const label = recoveryLabel(sourceId);
    // Match ACP (Grok) or native subagent (Mona) rows for the same recovery label.
    const matches = (await this.listTasks()).filter(
      (task) => (task.runtime === "acp" || task.runtime === "subagent") && task.title === label,
    );
    if (matches.length > 1) {
      throw new Error(`Multiple tasks match Wave Runner source identity ${sourceId}; refusing ambiguous recovery.`);
    }
    const task = matches[0];
    const id = task && taskId(task);
    // subagent tasks may surface sessionKey instead of childSessionKey
    const sessionId = task?.childSessionKey || task?.sessionKey;
    if (!task?.runId || !sessionId || !id) return undefined;
    return { runId: task.runId, sessionId, taskId: id };
  }

  private async getTask(id: string): Promise<GatewayTask | undefined> {
    try {
      const response = await this.request<{ task?: GatewayTask }>("tasks.get", { taskId: id });
      return response.task;
    } catch {
      return undefined;
    }
  }

  private async listTasks(): Promise<GatewayTask[]> {
    const tasks: GatewayTask[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.request<TaskListResponse>("tasks.list", {
        sessionKey: this.requesterSessionKey,
        limit: 500,
        ...(cursor ? { cursor } : {}),
      });
      if (Array.isArray(response.tasks)) tasks.push(...response.tasks);
      cursor = typeof response.nextCursor === "string" ? response.nextCursor : undefined;
    } while (cursor);
    return tasks;
  }

  private async findTask(input: {
    runId?: string;
    childSessionKey?: string;
    title?: string;
  }): Promise<GatewayTask | undefined> {
    const matches = (await this.listTasks()).filter((task) => {
      if (input.runId && task.runId === input.runId) return true;
      if (input.childSessionKey && task.childSessionKey === input.childSessionKey) return true;
      return Boolean(input.title && task.runtime === "acp" && task.title === input.title);
    });
    if (matches.length > 1) {
      const exactRun = input.runId ? matches.filter((task) => task.runId === input.runId) : [];
      if (exactRun.length === 1) return exactRun[0];
      // OpenClaw records both a wrapper row and the ACP child against the same
      // runId/childSessionKey. Prefer the ACP runtime row.
      const acpExact = (exactRun.length > 0 ? exactRun : matches).filter((task) => task.runtime === "acp");
      if (acpExact.length === 1) return acpExact[0];
      if (input.childSessionKey) {
        const acpChild = acpExact.filter((task) => task.childSessionKey === input.childSessionKey);
        if (acpChild.length === 1) return acpChild[0];
      }
      throw new Error("Multiple public task-ledger rows match one ACP worker receipt.");
    }
    return matches[0];
  }
}

export const __test = { mapTaskTruth, parseToolJson, recoveryLabel };
