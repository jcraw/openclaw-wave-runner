import { AdmissionDeniedError } from "../domain/errors.js";
import type { StageName } from "../domain/types.js";
import { queueStage } from "./admission.js";
import type { AdmitBlocker } from "./admit-overlap.js";
import { stopForBudget } from "./budget-stop.js";
import type { ControllerContext } from "./controller-context.js";

export type HopTicket = {
  ticketId?: string;
  planReviewSkip?: boolean;
  needsUx?: boolean;
};

/** PLAN + optional Crawmak REVIEW + optional Mona UX_REVIEW + IMPL. */
export function hopsForTicket(ticket: HopTicket): number {
  const crawmak = ticket.planReviewSkip === true ? 0 : 1;
  const ux = ticket.needsUx === true ? 1 : 0;
  return 1 + crawmak + ux + 1;
}

export function requiredLaunches(tickets: HopTicket[]): number {
  return tickets.reduce((sum, ticket) => sum + hopsForTicket(ticket), 0);
}

export function hopsExceedBlockers(tickets: HopTicket[], maxLaunches: number): AdmitBlocker[] {
  const need = requiredLaunches(tickets);
  if (need <= maxLaunches) return [];
  return tickets.map((ticket) => ({
    ticketId: ticket.ticketId ?? "wave",
    code: "hops_exceed_max_launches",
    message: `need ${need} launches (PLAN/REVIEW/UX/IMPL) for ${tickets.length} tickets; maxLaunches=${maxLaunches}`,
  }));
}

const HARD_BUDGET = /max_launches|token ceiling|cost ceiling|wall-time|stop_at/;

export function isHardBudgetAdmit(err: unknown): boolean {
  return err instanceof AdmissionDeniedError && HARD_BUDGET.test(err.message);
}

export type QueueAdmitResult = "queued" | "deferred" | "stopped";

/**
 * Admit a stage. Hard budget while idle → BUDGET_STOPPED (do not throw; that
 * kills the operator). Hard budget with in-flight work → defer. Other errors
 * still throw when idle.
 */
export async function queueStageOrBudget(
  ctrl: ControllerContext,
  waveId: string,
  ticketId: string,
  stage: StageName,
  idle: boolean,
): Promise<QueueAdmitResult> {
  try {
    await queueStage(ctrl, waveId, ticketId, stage);
    return "queued";
  } catch (err) {
    if (isHardBudgetAdmit(err)) {
      if (idle) {
        const reason = err instanceof Error ? err.message.replace(/^Admission denied: /, "") : "budget";
        stopForBudget(ctrl, waveId, reason);
        return "stopped";
      }
      return "deferred";
    }
    if (idle) throw err;
    return "deferred";
  }
}
