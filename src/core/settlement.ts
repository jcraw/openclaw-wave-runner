import { randomUUID } from "node:crypto";

import { hashJson } from "../domain/hash.js";
import type { LaunchOutbox, LaunchReceipt, TicketRun, WaveRecord } from "../domain/types.js";
import { applySettlement, markIndeterminate } from "./budget.js";
import type { ControllerContext } from "./controller-context.js";
import { refreshCounters, requireTicket, requireWave } from "./controller-context.js";
import { finalizeImplLand, implFenceFailure } from "./land-closeout.js";
import { releaseWriterLeaseIfHeld } from "./lease-release.js";
import { markSettled } from "./outbox.js";
import { applyPlanSuccess } from "./plan-settle.js";
import { readActualPlanText } from "./plan-text.js";
import {
  assertTicketTransition,
  TICKET_NEXT,
  TICKET_OWNERS,
  WAVE_NEXT,
  WAVE_OWNERS,
} from "./state-machine.js";

const REASON_CAP = 500;

function clipReason(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= REASON_CAP ? t : `${t.slice(0, REASON_CAP - 1)}…`;
}

/** Durable short reason for inspect / cascade (WR-005 + WR-010). */
export function stageDeathReason(input: {
  status: "failed" | "cancelled";
  summary?: string;
  error?: string;
  stage: "PLAN" | "IMPL" | "VERIFY";
  attempt: number;
}): string {
  const fromWorker = clipReason(input.summary ?? input.error ?? "");
  if (fromWorker) return fromWorker;
  const kind = input.status === "cancelled" ? "worker cancelled (no stage artifacts)" : "worker failed";
  return clipReason(`${input.stage} attempt ${input.attempt}: ${kind}`);
}

function putTicketStatus(
  ctrl: ControllerContext,
  ticket: TicketRun,
  status: TicketRun["status"],
  result?: string,
): void {
  ticket.status = status;
  if (result !== undefined) ticket.result = result;
  ticket.owner = TICKET_OWNERS[status];
  ticket.nextAction = TICKET_NEXT[status];
  ticket.revision += 1;
  ctrl.db.putTicket(ticket);
}

function setWaveStatus(ctrl: ControllerContext, wave: WaveRecord, status: WaveRecord["status"], now: number): void {
  wave.status = status;
  wave.owner = WAVE_OWNERS[status];
  wave.nextAction = WAVE_NEXT[status];
  wave.revision += 1;
  wave.updatedAt = now;
  ctrl.db.putWave(wave);
}

export async function settleOutbox(
  ctrl: ControllerContext,
  item: LaunchOutbox,
  receipt: LaunchReceipt,
  status: "succeeded" | "failed" | "cancelled",
  outputRef?: string,
  summary?: string,
  error?: string,
): Promise<void> {
  const usage = await ctrl.usage.settle(receipt);
  const receiptSucceeded = status === "succeeded";
  const waveId = item.waveId;
  let planPath: string | undefined;
  if (item.stage === "PLAN" && status === "succeeded") {
    const ticket = requireTicket(ctrl, waveId, item.ticketId);
    const planText = readActualPlanText({
      ticketId: item.ticketId,
      planClass: ticket.planClass,
      summary,
      outputRef,
      outputDir: receipt.outputDir,
    });
    planPath = await ctrl.workspace.writePlanArtifact({
      repoPath: requireWave(ctrl, waveId).repoPath,
      waveId,
      ticketId: item.ticketId,
      contents: planText,
      ...(ctrl.artifactRoot ? { artifactRoot: ctrl.artifactRoot } : {}),
    });
    summary = planText;
  }
  let verifyProof: string | undefined;
  let verifyFailSnippet: string | undefined;
  if (item.stage === "IMPL" && status === "succeeded") {
    const ticket = requireTicket(ctrl, waveId, item.ticketId);
    const wave = requireWave(ctrl, waveId);
    const fence = implFenceFailure(ctrl, item, ticket, wave);
    if (fence) {
      status = "failed";
      verifyFailSnippet = fence;
    } else if (!ticket.verifyCommand) {
      status = "failed";
      verifyFailSnippet = "missing_verify";
    } else if (ticket.implWorktree) {
      const verify = await ctrl.workspace.verify({
        worktree: ticket.implWorktree,
        command: ticket.verifyCommand,
      });
      verifyProof = verify.proof;
      if (!verify.ok) {
        status = "failed";
        verifyFailSnippet = clipReason(`verify failed: ${ticket.verifyCommand} (${verify.proof})`);
      }
    }
  }

  ctrl.db.transaction(() => {
    const now = ctrl.clock.now();
    const row = ctrl.db.getOutboxByIdempotency(item.idempotencyKey);
    if (!row || row.state === "SETTLED") return;
    ctrl.db.putOutbox(markSettled(row, now));
    const stage = ctrl.db.getStageByIdempotency(item.idempotencyKey);
    if (stage) {
      stage.status = status === "succeeded" ? "SUCCEEDED" : status === "cancelled" ? "CANCELLED" : "FAILED";
      stage.outputRef = outputRef;
      ctrl.db.putStage(stage);
      const budget = ctrl.db.listBudgets(waveId).find((b) => b.stageRunId === stage.stageRunId);
      if (budget) {
        ctrl.db.putBudget(
          usage.kind === "actual"
            ? applySettlement(budget, usage.tokens, usage.costMicros, now)
            : markIndeterminate(budget, now),
        );
      }
    }
    const ticket = requireTicket(ctrl, waveId, item.ticketId);
    const wave = requireWave(ctrl, waveId);
    if (status !== "succeeded") {
      const attempt = stage?.attempt ?? item.attempt ?? 1;
      let reason = stageDeathReason({
        status,
        summary: verifyFailSnippet ?? summary,
        error,
        stage: item.stage,
        attempt,
      });
      const flipped = receiptSucceeded && !wave.cancelRequested;
      if (flipped) reason = clipReason(`controller failed (worker succeeded): ${reason}`);
      if (wave.cancelRequested) {
        putTicketStatus(ctrl, ticket, "CANCELLED", reason || "operator cancel");
      } else {
        const retriesRemain = attempt - 1 < wave.limits.maxRetriesPerStage;
        const noRetry =
          verifyFailSnippet === "missing_verify" || (verifyFailSnippet?.startsWith("stale_fence") ?? false);
        if (retriesRemain && (item.stage === "PLAN" || item.stage === "IMPL") && !noRetry) {
          const rearm = item.stage === "PLAN" ? "REVISING" : "APPROVED";
          assertTicketTransition(ticket.status, rearm, false);
          putTicketStatus(ctrl, ticket, rearm, clipReason(`retry ${attempt + 1} after: ${reason}`));
          if (wave.status === "WAITING_APPROVAL" || wave.status === "AWAITING_PLAN_GATE") {
            setWaveStatus(ctrl, wave, "RUNNING", now);
          }
        } else {
          putTicketStatus(ctrl, ticket, "FAILED", reason);
          if (flipped) {
            ctrl.db.putArtifact({
              artifactId: `${waveId}:art:${randomUUID()}`,
              waveId,
              ticketId: item.ticketId,
              kind: "settle-reason",
              path: reason,
              hash: hashJson(reason),
              createdAt: now,
            });
          }
        }
      }
      if (item.stage === "IMPL") releaseWriterLeaseIfHeld(ctrl, wave, ticket);
    } else if (item.stage === "PLAN") {
      applyPlanSuccess(ctrl, wave, ticket, planPath, summary, now);
    } else if (item.stage === "IMPL") {
      // Keep writer lease through verify+land; releaseWriterLeaseAfterLand frees it.
      // Fail path above still releases immediately so same-scope siblings are not starved (WR-019).
      ticket.verifyProof = verifyProof;
      putTicketStatus(ctrl, ticket, "VERIFYING");
    }
    for (const [kind, path] of [
      ["plan", planPath],
      ["proof", verifyProof],
    ] as const) {
      if (!path) continue;
      ctrl.db.putArtifact({
        artifactId: `${waveId}:art:${randomUUID()}`,
        waveId,
        ticketId: item.ticketId,
        kind,
        path,
        hash: hashJson(path),
        createdAt: now,
      });
    }
    refreshCounters(ctrl, waveId);
  });

  if (item.stage === "IMPL" && status === "succeeded") {
    await finalizeImplLand(ctrl, item);
  }

  const ticket = ctrl.db.getTicket(waveId, item.ticketId);
  if (ticket && !ctrl.disableSourceMirror) {
    try {
      await ctrl.tracker.mirror({
        ticketId: ticket.ticketId,
        status: ticket.status,
        phase: ticket.stage,
        waveId,
        plan: ticket.planArtifact,
        workerOutDir: ticket.implWorktree,
        result: ticket.result,
        proof: ticket.verifyProof,
      });
    } catch {
      // Projection failure must not roll back durable state.
    }
  }
  const liveAfter = requireWave(ctrl, waveId);
  if (liveAfter.status === "AWAITING_PLAN_GATE") {
    const t = ctrl.db.getTicket(waveId, item.ticketId);
    if (t && ctrl.wake) {
      try {
        await ctrl.wake.emitOnce({
          waveId,
          ticketId: item.ticketId,
          planPath: t.planArtifact,
          revision: t.revision,
        });
      } catch {
        // Host wake is best-effort; ledger event is the receipt.
      }
    }
  } else if (liveAfter.status === "WAITING_APPROVAL" && liveAfter.flowId) {
    try {
      await ctrl.workflow.waitForApproval({
        flowId: liveAfter.flowId,
        expectedRevision: 0,
        currentStep: "await-operator-approval",
        stateJson: { waveId, ticketId: item.ticketId },
        waitJson: { kind: "operator-approval", ticketId: item.ticketId },
      });
    } catch {
      // Workflow projection is non-authoritative.
    }
  }
}
