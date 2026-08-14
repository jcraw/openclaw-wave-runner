import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { hashJson } from "../domain/hash.js";
import type { LaunchOutbox, LaunchReceipt } from "../domain/types.js";
import { repoWriterKey } from "../domain/types.js";
import { applySettlement, markIndeterminate } from "./budget.js";
import type { ControllerContext } from "./controller-context.js";
import { refreshCounters, requireTicket, requireWave } from "./controller-context.js";
import { releaseLease } from "./lease.js";
import { markSettled } from "./outbox.js";
import { TICKET_NEXT, TICKET_OWNERS, WAVE_NEXT, WAVE_OWNERS } from "./state-machine.js";

export async function settleOutbox(
  ctrl: ControllerContext,
  item: LaunchOutbox,
  receipt: LaunchReceipt,
  status: "succeeded" | "failed" | "cancelled",
  outputRef?: string,
  summary?: string,
): Promise<void> {
  const usage = await ctrl.usage.settle(receipt);
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
  if (item.stage === "IMPL" && status === "succeeded") {
    const ticket = requireTicket(ctrl, waveId, item.ticketId);
    const worktree = ticket.implWorktree;
    if (worktree) {
      const verify = await ctrl.workspace.verify({
        worktree,
        command: ticket.verifyCommand ?? "true",
      });
      verifyProof = verify.proof;
      if (!verify.ok) status = "failed";
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
        if (usage.kind === "actual") {
          ctrl.db.putBudget(applySettlement(budget, usage.tokens, usage.costMicros, now));
        } else {
          ctrl.db.putBudget(markIndeterminate(budget, now));
        }
      }
    }
    const ticket = requireTicket(ctrl, waveId, item.ticketId);
    const wave = requireWave(ctrl, waveId);
    if (status !== "succeeded") {
      ticket.status = status === "cancelled" ? "CANCELLED" : "FAILED";
      ticket.result = summary ?? status;
      ticket.revision += 1;
      ctrl.db.putTicket(ticket);
    } else if (item.stage === "PLAN") {
      ticket.status = "PLAN_REVIEW";
      ticket.planArtifact = planPath;
      ticket.owner = TICKET_OWNERS.PLAN_REVIEW;
      ticket.nextAction = TICKET_NEXT.PLAN_REVIEW;
      ticket.revision += 1;
      ctrl.db.putTicket(ticket);
      const decision = ctrl.policy.decide({
        planClass: ticket.planClass,
        planText: summary ?? "",
      });
      if (decision === "wait") {
        wave.status = "WAITING_APPROVAL";
        wave.owner = WAVE_OWNERS.WAITING_APPROVAL;
        wave.nextAction = WAVE_NEXT.WAITING_APPROVAL;
        wave.revision += 1;
        wave.updatedAt = now;
        ctrl.db.putWave(wave);
      } else {
        ticket.status = "APPROVED";
        ticket.owner = TICKET_OWNERS.APPROVED;
        ticket.nextAction = TICKET_NEXT.APPROVED;
        ticket.revision += 1;
        ctrl.db.putTicket(ticket);
      }
    } else if (item.stage === "IMPL") {
      ticket.status = "VERIFYING";
      ticket.verifyProof = verifyProof;
      ticket.owner = TICKET_OWNERS.VERIFYING;
      ticket.nextAction = TICKET_NEXT.VERIFYING;
      ticket.revision += 1;
      ctrl.db.putTicket(ticket);
      ticket.status = "DONE";
      ticket.result = "verified";
      ticket.owner = TICKET_OWNERS.DONE;
      ticket.nextAction = TICKET_NEXT.DONE;
      ticket.revision += 1;
      ctrl.db.putTicket(ticket);
      const lease = ctrl.db.getLease(repoWriterKey(wave.repoPath));
      if (lease && lease.ticketId === ticket.ticketId) {
        releaseLease({
          current: lease,
          claimant: ctrl.process,
          expectedGeneration: lease.generation,
          now,
        });
        ctrl.db.deleteLease(lease.resourceKey);
      }
    }
    if (planPath) {
      ctrl.db.putArtifact({
        artifactId: `${waveId}:art:${randomUUID()}`,
        waveId,
        ticketId: item.ticketId,
        kind: "plan",
        path: planPath,
        hash: hashJson(planPath),
        createdAt: now,
      });
    }
    if (verifyProof) {
      ctrl.db.putArtifact({
        artifactId: `${waveId}:art:${randomUUID()}`,
        waveId,
        ticketId: item.ticketId,
        kind: "proof",
        path: verifyProof,
        hash: hashJson(verifyProof),
        createdAt: now,
      });
    }
    refreshCounters(ctrl, waveId);
  });

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
  if (requireWave(ctrl, waveId).status === "WAITING_APPROVAL" && requireWave(ctrl, waveId).flowId) {
    const live = requireWave(ctrl, waveId);
    try {
      await ctrl.workflow.waitForApproval({
        flowId: live.flowId!,
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

function readActualPlanText(input: {
  ticketId: string;
  planClass?: string;
  summary?: string;
  outputRef?: string;
  outputDir?: string;
}): string {
  const candidates: string[] = [];
  if (input.outputDir) {
    candidates.push(join(input.outputDir, "PLAN.md"));
  }
  if (input.outputRef && existsSync(input.outputRef)) {
    try {
      const stat = statSync(input.outputRef);
      if (stat.isFile() && input.outputRef.endsWith("PLAN.md")) {
        candidates.push(input.outputRef);
      } else if (stat.isDirectory() && input.outputDir && input.outputRef === input.outputDir) {
        candidates.push(join(input.outputRef, "PLAN.md"));
      }
    } catch {
      // Never fall back to another stage's PLAN.md.
    }
  }
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, "utf8").trim();
      if (text) return text;
    } catch {
      // Try the next candidate.
    }
  }
  return `# PLAN ${input.ticketId}

${input.summary ?? "deterministic plan"}

class: ${input.planClass ?? "manual"}
`;
}
