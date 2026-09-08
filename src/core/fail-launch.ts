import { SafetyGateError } from "../domain/errors.js";
import type { LaunchOutbox, LaunchReceipt, TicketRun } from "../domain/types.js";
import { markIndeterminate } from "./budget.js";
import { CrashInjectedError, type ControllerContext } from "./controller-context.js";
import { refreshCounters, requireTicket, requireWave } from "./controller-context.js";
import { markFailed } from "./outbox.js";
import type { LaunchIntent } from "./ports.js";
import { stageDeathNoRetry } from "./settlement.js";
import { isPlanGateStage } from "./stage-paths.js";
import { assertTicketTransition, TICKET_NEXT, TICKET_OWNERS } from "./state-machine.js";

const REASON_CAP = 500;

function clipReason(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= REASON_CAP ? t : `${t.slice(0, REASON_CAP - 1)}…`;
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

export async function launchClaimed(
  ctrl: ControllerContext,
  claimed: LaunchOutbox,
  intent: LaunchIntent,
): Promise<LaunchReceipt | undefined> {
  if (ctrl.crashAt === "after_launch" || ctrl.crashAt === "before_receipt_commit") {
    await ctrl.worker.launch(intent);
    throw new CrashInjectedError(ctrl.crashAt);
  }
  try {
    return await ctrl.worker.launch(intent);
  } catch (err) {
    if (err instanceof CrashInjectedError || err instanceof SafetyGateError) throw err;
    failLaunchWithoutReceipt(ctrl, claimed, err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

export function lostSpawnReason(item: LaunchOutbox): string {
  const prior = item.error ?? "";
  if (/Unknown agent id|unknown_acp_agent|grok_agent_missing/i.test(prior)) return "unknown_acp_agent";
  return "lost_spawn";
}

/** Fail a CLAIMED/RECONCILING row with no receipt; stamp ticket via hop/retry/no-retry. */
export function failLaunchWithoutReceipt(
  ctrl: ControllerContext,
  item: LaunchOutbox,
  reason: string,
): void {
  ctrl.db.transaction(() => {
    const now = ctrl.clock.now();
    const row = ctrl.db.getOutboxByIdempotency(item.idempotencyKey);
    if (!row || row.state === "SETTLED" || row.state === "FAILED") return;
    const clipped = clipReason(reason);
    ctrl.db.putOutbox(markFailed(row, clipped, now));
    const stage = ctrl.db.getStageByIdempotency(item.idempotencyKey);
    if (stage) {
      stage.status = "FAILED";
      ctrl.db.putStage(stage);
      const budget = ctrl.db.listBudgets(item.waveId).find((b) => b.stageRunId === stage.stageRunId);
      if (budget) ctrl.db.putBudget(markIndeterminate(budget, now));
    }
    const ticket = requireTicket(ctrl, item.waveId, item.ticketId);
    const wave = requireWave(ctrl, item.waveId);
    if (
      ticket.status === "FAILED" ||
      ticket.status === "CANCELLED" ||
      ticket.status === "DONE" ||
      ticket.status === "BLOCKED" ||
      ticket.status === "BUDGET_STOPPED"
    ) {
      refreshCounters(ctrl, item.waveId);
      return;
    }
    const attempt = stage?.attempt ?? item.attempt ?? 1;
    const noRetry = stageDeathNoRetry({
      reason: clipped,
      stage: item.stage,
      planWorker: ticket.planWorker,
    });
    const retriesRemain = attempt - 1 < wave.limits.maxRetriesPerStage;
    if (
      retriesRemain &&
      (item.stage === "PLAN" || item.stage === "IMPL" || isPlanGateStage(item.stage)) &&
      !noRetry
    ) {
      const rearm = item.stage === "PLAN" ? "REVISING" : isPlanGateStage(item.stage) ? "PLAN_REVIEW" : "APPROVED";
      assertTicketTransition(ticket.status, rearm, false);
      putTicketStatus(ctrl, ticket, rearm, clipReason(`retry ${attempt + 1} after: ${clipped}`));
    } else {
      putTicketStatus(ctrl, ticket, "FAILED", clipped);
    }
    refreshCounters(ctrl, item.waveId);
  });
}
