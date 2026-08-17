import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { LaunchReceipt } from "../domain/types.js";
import type { ReadOnlyTasks } from "../contracts.js";
import type { AcpSpawn, CancelResult, LaunchIntent, WorkerAdapter } from "./ports.js";
import {
  ensureStageAttemptDir,
  inspectReceiptArtifacts,
  readJsonFile,
  stageAttemptDir,
  writeJsonAtomic,
} from "./stage-artifacts.js";

export const MISSING_ACP_SPAWN_MESSAGE =
  "product worker launch requires an injected public ACP spawn port; native subagent and grok CLI are not the product path.";

export class MissingAcpSpawnWorker implements WorkerAdapter {
  readonly kind = "missing-acp";

  async launch(): Promise<LaunchReceipt> {
    throw new Error(MISSING_ACP_SPAWN_MESSAGE);
  }

  async inspect(): Promise<{ status: "unknown"; error: string }> {
    return { status: "unknown", error: MISSING_ACP_SPAWN_MESSAGE };
  }

  async recover(): Promise<undefined> {
    return undefined;
  }

  async cancel(): Promise<CancelResult> {
    return { cancelled: false, reason: MISSING_ACP_SPAWN_MESSAGE };
  }
}

export type GrokAcpWorkerOptions = {
  acp: AcpSpawn;
  tasks?: ReadOnlyTasks;
  agentId?: "grok";
  model?: string;
};

function resolveOutputDir(intent: LaunchIntent): string {
  if (intent.outputDir) return intent.outputDir;
  const root = intent.worktree ?? ".";
  return stageAttemptDir({
    root,
    waveId: intent.waveId,
    ticketId: intent.ticketId,
    stage: intent.stage,
    attempt: intent.attempt ?? 1,
  });
}

function stageBrief(intent: LaunchIntent, outputDir: string): string {
  const isolated = intent.worktree
    ? `Isolated worktree only: ${intent.worktree}. Do not touch any other checkout.`
    : "Do not touch any checkout.";
  const attempt = intent.attempt ?? 1;
  const terminal = JSON.stringify(
    {
      idempotencyKey: intent.idempotencyKey,
      waveId: intent.waveId,
      ticketId: intent.ticketId,
      stage: intent.stage,
      attempt,
      status: "succeeded",
      artifact: intent.stage === "PLAN" ? "PLAN.md" : intent.stage === "IMPL" ? "IMPL_DONE.json" : "VERIFY.json",
    },
    null,
    2,
  );
  const ticketBrief = intent.prompt.trim()
    ? `\nTicket/stage brief:\n\n${intent.prompt.trim()}\n`
    : "";
  if (intent.stage === "PLAN") {
    return `# ${intent.ticketId} PLAN ONLY

${isolated}

Fresh ACP session. PLAN ONLY. Do not implement product code.
Write the plan to ${join(outputDir, "PLAN.md")}.
Also write ${join(outputDir, "terminal.json")} with exactly these identity fields (optional hash is allowed):
${terminal}
${ticketBrief}
No deploy, push, merge, or Gateway changes. Then STOP.
`;
  }
  if (intent.stage === "IMPL") {
    const plan = intent.approvedPlanPath ?? "the approved PLAN artifact";
    return `# ${intent.ticketId} IMPLEMENT

${isolated}

Fresh ACP session. Do not resume the PLAN conversation.
Execute the approved plan at ${plan}.
Write ${join(outputDir, "IMPL_DONE.json")} and ${join(outputDir, "terminal.json")} for IMPL attempt ${attempt}.
terminal.json must contain these identity fields (optional hash is allowed):
${terminal}
${ticketBrief}
PLAN.md is input only and never completes this stage.
No deploy, push, merge, or Gateway changes.
`;
  }
  return `# ${intent.ticketId} VERIFY

${isolated}

Fresh ACP session. Verify only. Write ${join(outputDir, "VERIFY.json")} and ${join(outputDir, "terminal.json")}.
terminal.json must contain these identity fields (optional hash is allowed):
${terminal}
${ticketBrief}
`;
}

export class GrokAcpWorker implements WorkerAdapter {
  readonly kind = "grok-acp";
  private readonly receipts = new Map<string, LaunchReceipt>();

  constructor(private readonly opts: GrokAcpWorkerOptions) {}

  async launch(intent: LaunchIntent): Promise<LaunchReceipt> {
    const existing = await this.recover(intent);
    if (existing) return existing;
    const outputDir = resolveOutputDir(intent);
    ensureStageAttemptDir(outputDir);
    const brief = stageBrief(intent, outputDir);
    writeFileSync(join(outputDir, "brief.md"), brief, "utf8");
    writeJsonAtomic(join(outputDir, "launch-intent.json"), {
      idempotencyKey: intent.idempotencyKey,
      waveId: intent.waveId,
      ticketId: intent.ticketId,
      stage: intent.stage,
      attempt: intent.attempt ?? 1,
      sessionKey: intent.sessionKey,
      approvedPlanPath: intent.approvedPlanPath,
      outputDir,
    });
    if (intent.approvedPlanPath && existsSync(intent.approvedPlanPath)) {
      const dest = join(outputDir, "APPROVED_PLAN.md");
      if (!existsSync(dest)) copyFileSync(intent.approvedPlanPath, dest);
    }
    const spawned = await this.opts.acp.spawn({
      agentId: this.opts.agentId ?? "grok",
      mode: "run",
      sessionKey: intent.sessionKey,
      cwd: intent.worktree,
      task: brief,
      sourceId: intent.idempotencyKey,
    });
    const receipt: LaunchReceipt = {
      idempotencyKey: intent.idempotencyKey,
      taskId: spawned.taskId,
      runId: spawned.runId,
      sessionId: spawned.sessionId,
      provider: "grok-acp",
      model: intent.model ?? this.opts.model ?? "grok-4.6",
      outputDir,
    };
    this.receipts.set(intent.idempotencyKey, receipt);
    writeJsonAtomic(join(outputDir, "launch-receipt.json"), receipt);
    return receipt;
  }

  async recover(intent: LaunchIntent): Promise<LaunchReceipt | undefined> {
    const cached = this.receipts.get(intent.idempotencyKey);
    if (cached) return cached;
    const found = await this.opts.acp.findBySourceId(intent.idempotencyKey);
    if (found) {
      const receipt: LaunchReceipt = {
        idempotencyKey: intent.idempotencyKey,
        taskId: found.taskId,
        runId: found.runId,
        sessionId: found.sessionId,
        provider: "grok-acp",
        model: intent.model ?? this.opts.model ?? "grok-4.6",
        outputDir: resolveOutputDir(intent),
      };
      this.receipts.set(intent.idempotencyKey, receipt);
      return receipt;
    }
    const outputDir = resolveOutputDir(intent);
    const disk = readJsonFile<LaunchReceipt>(join(outputDir, "launch-receipt.json"));
    if (disk?.idempotencyKey === intent.idempotencyKey) {
      this.receipts.set(intent.idempotencyKey, disk);
      return disk;
    }
    return undefined;
  }

  async inspect(receipt: LaunchReceipt) {
    const sourceId = receipt.idempotencyKey;
    const acpTruth = await this.opts.acp.inspect({
      runId: receipt.runId,
      taskId: receipt.taskId,
      sessionId: receipt.sessionId,
      sourceId,
    });
    const artifacts = inspectReceiptArtifacts(receipt);
    // Artifact-first: matching same-stage terminal + required artifact wins
    // even if ACP is still queued/running (MUD-037). Stale PLAN.md in an IMPL
    // dir is not IMPL success — inspectReceiptArtifacts requires IMPL_DONE.
    if (artifacts?.status === "succeeded") {
      return { ...artifacts, outputRef: receipt.outputDir };
    }
    if (acpTruth.status === "queued" || acpTruth.status === "running") {
      return { status: "running" as const, outputRef: receipt.outputDir };
    }
    if (acpTruth.status === "lost" || acpTruth.status === "unknown") {
      return acpTruth;
    }
    if (!receipt.outputDir) {
      if (acpTruth.status === "failed" || acpTruth.status === "cancelled" || acpTruth.status === "succeeded") {
        return acpTruth;
      }
      return { status: "unknown" as const, error: "ACP receipt is missing outputDir" };
    }
    if (acpTruth.status === "failed" || acpTruth.status === "cancelled") {
      return acpTruth;
    }
    return artifacts ?? { status: "unknown" as const, error: "missing stage artifacts", outputRef: receipt.outputDir };
  }

  async cancel(receipt: LaunchReceipt) {
    return this.opts.acp.cancel({
      runId: receipt.runId,
      taskId: receipt.taskId,
      sessionId: receipt.sessionId,
      sourceId: receipt.idempotencyKey,
    });
  }
}
