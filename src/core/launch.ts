import type { LaunchOutbox, LaunchReceipt } from "../domain/types.js";
import { CrashInjectedError, type ControllerContext } from "./controller-context.js";
import { requireTicket, requireWave } from "./controller-context.js";
import { isLeaseStale } from "./lease.js";
import {
  claimOutbox,
  markFailed,
  markLaunched,
  markReconciling,
} from "./outbox.js";
import type { LaunchIntent } from "./ports.js";
import { settleOutbox } from "./settlement.js";
import { stageAttemptDir, stageSessionKey } from "./stage-paths.js";

export function refreshHeldLeases(ctrl: ControllerContext, waveId: string): void {
  const now = ctrl.clock.now();
  for (const lease of ctrl.db.listLeases(waveId)) {
    if (
      lease.holder === ctrl.process.holder &&
      lease.processIdentity === ctrl.process.processIdentity
    ) {
      ctrl.db.putLease({ ...lease, expiresAt: now + ctrl.leaseTtlMs });
    }
  }
}

export function expireStaleLeases(ctrl: ControllerContext): number {
  ctrl.watchdogFires += 1;
  // Deterministic watchdog: never call an LLM.
  let expired = 0;
  for (const lease of ctrl.db.listLeases()) {
    if (isLeaseStale(lease, ctrl.clock.now())) {
      ctrl.db.deleteLease(lease.resourceKey);
      expired += 1;
    }
  }
  return expired;
}

export function intentFromOutbox(ctrl: ControllerContext, item: LaunchOutbox): LaunchIntent {
  const ticket = requireTicket(ctrl, item.waveId, item.ticketId);
  const root = ticket.implWorktree ?? ctrl.artifactRoot ?? ctrl.worktreeRoot ?? ".";
  const outputDir = stageAttemptDir({
    root,
    waveId: item.waveId,
    ticketId: item.ticketId,
    stage: item.stage,
    attempt: item.attempt,
  });
  return {
    idempotencyKey: item.idempotencyKey,
    waveId: item.waveId,
    ticketId: item.ticketId,
    stage: item.stage,
    attempt: item.attempt,
    prompt: `${item.stage} ${item.ticketId} ${ticket.title}`,
    sessionKey: stageSessionKey({
      waveId: item.waveId,
      ticketId: item.ticketId,
      stage: item.stage,
      attempt: item.attempt,
    }),
    worktree: ticket.implWorktree,
    outputDir,
    approvedPlanPath: item.stage === "PLAN" ? undefined : ticket.planArtifact,
    provider: ticket.provider,
    model: ticket.model,
  };
}

export async function reconcile(ctrl: ControllerContext, waveId: string): Promise<void> {
  const open = ctrl.db.listOutbox(waveId).filter((item) =>
    item.state === "CLAIMED" || item.state === "LAUNCHED" || item.state === "RECONCILING",
  );
  for (const item of open) {
    ctrl.db.transaction(() => {
      const current = ctrl.db.getOutboxByIdempotency(item.idempotencyKey);
      if (!current) return;
      if (current.state === "CLAIMED" || current.state === "LAUNCHED") {
        ctrl.db.putOutbox(markReconciling(current, ctrl.clock.now()));
      }
    });
    const latest = ctrl.db.getOutboxByIdempotency(item.idempotencyKey);
    if (!latest) continue;
    if (!latest.receiptJson) {
      // Crash after spawn / before receipt commit must recover the existing
      // worker identity. Never spawn again from a receipt-less row.
      const recovered = await ctrl.worker.recover(intentFromOutbox(ctrl, latest));
      if (!recovered) {
        continue;
      }
      ctrl.db.transaction(() => {
        const row = ctrl.db.getOutboxByIdempotency(latest.idempotencyKey);
        if (!row) return;
        ctrl.db.putOutbox(markLaunched(row, JSON.stringify(recovered), ctrl.clock.now()));
        const stage = ctrl.db.getStageByIdempotency(latest.idempotencyKey);
        if (stage) {
          stage.taskId = recovered.taskId;
          stage.runId = recovered.runId;
          stage.sessionId = recovered.sessionId;
          stage.receiptJson = JSON.stringify(recovered);
          stage.status = "RUNNING";
          ctrl.db.putStage(stage);
        }
      });
      continue;
    }
    const receipt = JSON.parse(latest.receiptJson) as LaunchReceipt;
    const truth = await ctrl.worker.inspect(receipt);
    if (truth.status === "succeeded" || truth.status === "failed" || truth.status === "cancelled") {
      await settleOutbox(
        ctrl,
        latest,
        receipt,
        truth.status,
        truth.outputRef,
        truth.summary,
        truth.error,
      );
    } else if (latest.receiptJson) {
      ctrl.db.transaction(() => {
        const row = ctrl.db.getOutboxByIdempotency(latest.idempotencyKey);
        if (row && row.state === "RECONCILING") {
          ctrl.db.putOutbox(markLaunched(row, row.receiptJson ?? "{}", ctrl.clock.now()));
        }
      });
    }
  }
}

export async function dispatchPending(ctrl: ControllerContext, waveId: string): Promise<void> {
  const pending = ctrl.db.listOutbox(waveId).filter((item) => item.state === "PENDING");
  for (const item of pending) {
    ctrl.db.transaction(() => {
      const current = ctrl.db.getOutboxByIdempotency(item.idempotencyKey);
      if (!current || current.state !== "PENDING") return;
      ctrl.db.putOutbox(claimOutbox(current, ctrl.process.holder, ctrl.clock.now()));
    });
    const claimed = ctrl.db.getOutboxByIdempotency(item.idempotencyKey);
    if (!claimed) continue;
    if (requireWave(ctrl, waveId).cancelRequested) {
      ctrl.db.transaction(() => {
        const row = ctrl.db.getOutboxByIdempotency(claimed.idempotencyKey);
        if (row && row.state !== "SETTLED") {
          ctrl.db.putOutbox(markFailed(row, "cancelled before launch", ctrl.clock.now()));
        }
      });
      continue;
    }
    if (claimed.stage === "PLAN" || claimed.stage === "IMPL") {
      const ticket = requireTicket(ctrl, waveId, claimed.ticketId);
      if (!ticket.implWorktree) {
        const wave = requireWave(ctrl, waveId);
        const created = await ctrl.workspace.createImplWorktree({
          repoPath: wave.repoPath,
          baseSha: wave.baseSha,
          waveId,
          ticketId: claimed.ticketId,
          worktreeRoot: ctrl.worktreeRoot ?? `${wave.repoPath}/tmp/wave-runner/worktrees`,
        });
        ctrl.db.transaction(() => {
          const t = requireTicket(ctrl, waveId, claimed.ticketId);
          t.implWorktree = created.worktree;
          t.implBranch = created.branch;
          ctrl.db.putTicket(t);
        });
      }
    }
    if (ctrl.crashAt === "after_launch" || ctrl.crashAt === "before_receipt_commit") {
      await ctrl.worker.launch(intentFromOutbox(ctrl, claimed));
      throw new CrashInjectedError(ctrl.crashAt);
    }
    const receipt = await ctrl.worker.launch(intentFromOutbox(ctrl, claimed));
    if (requireWave(ctrl, waveId).flowId) {
      await ctrl.workflow.linkStageTask({
        flowId: requireWave(ctrl, waveId).flowId!,
        sourceId: claimed.idempotencyKey,
        label: `${claimed.stage}:${claimed.ticketId}`,
        task: `${claimed.stage} ${claimed.ticketId}`,
        childSessionKey: receipt.sessionId ?? claimed.idempotencyKey,
        runId: receipt.runId ?? claimed.idempotencyKey,
        runtime: receipt.provider === "openclaw-native" ? "subagent" : "acp",
      });
    }
    ctrl.db.transaction(() => {
      const row = ctrl.db.getOutboxByIdempotency(claimed.idempotencyKey);
      if (!row) return;
      ctrl.db.putOutbox(markLaunched(row, JSON.stringify(receipt), ctrl.clock.now()));
      const stage = ctrl.db.getStageByIdempotency(claimed.idempotencyKey);
      if (stage) {
        stage.status = "RUNNING";
        stage.taskId = receipt.taskId;
        stage.runId = receipt.runId;
        stage.sessionId = receipt.sessionId;
        stage.provider = receipt.provider ?? stage.provider;
        stage.model = receipt.model ?? stage.model;
        stage.receiptJson = JSON.stringify(receipt);
        ctrl.db.putStage(stage);
      }
    });
  }
}

export async function observeLaunched(ctrl: ControllerContext, waveId: string): Promise<void> {
  const launched = ctrl.db.listOutbox(waveId).filter((item) => item.state === "LAUNCHED");
  for (const item of launched) {
    const receipt = item.receiptJson
      ? (JSON.parse(item.receiptJson) as LaunchReceipt)
      : { idempotencyKey: item.idempotencyKey };
    const truth = await ctrl.worker.inspect(receipt);
    if (truth.status === "succeeded" || truth.status === "failed" || truth.status === "cancelled") {
      if (ctrl.crashAt === "after_completion" || ctrl.crashAt === "before_settlement") {
        throw new CrashInjectedError(ctrl.crashAt);
      }
      await settleOutbox(
        ctrl,
        item,
        receipt,
        truth.status,
        truth.outputRef,
        truth.summary,
        truth.error,
      );
    }
  }
}
