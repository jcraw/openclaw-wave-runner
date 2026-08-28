import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { LaunchReceipt } from "../domain/types.js";
import type { ReadOnlyTasks } from "../contracts.js";
import { acpTimeoutSeconds } from "../core/stage-watchdog.js";
import type { AcpSpawn, CancelResult, LaunchIntent, WorkerAdapter } from "./ports.js";
import { stageBrief } from "./stage-briefs.js";
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
  agentId?: "grok" | "mona";
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
    if (intent.uxSpecPath && existsSync(intent.uxSpecPath)) {
      const dest = join(outputDir, "UX_SPEC.md");
      if (!existsSync(dest)) copyFileSync(intent.uxSpecPath, dest);
    }
    const spawned = await this.opts.acp.spawn({
      agentId: intent.agentId ?? this.opts.agentId ?? "grok",
      mode: "run",
      sessionKey: intent.sessionKey,
      cwd: intent.worktree,
      task: brief,
      sourceId: intent.idempotencyKey,
      timeoutMs: acpTimeoutSeconds(intent.stage) * 1000,
    });
    const receipt: LaunchReceipt = {
      idempotencyKey: intent.idempotencyKey,
      taskId: spawned.taskId,
      runId: spawned.runId,
      sessionId: spawned.sessionId,
      provider: "grok-acp",
      model: intent.model ?? this.opts.model ?? "grok-4.6",
      outputDir,
      cwd: intent.worktree,
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
        cwd: intent.worktree,
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
