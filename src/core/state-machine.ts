import { CancelledError, StaleRevisionError, WaveError } from "../domain/errors.js";
import type {
  TicketStatus,
  WaveStatus,
} from "../domain/types.js";
import { TERMINAL_TICKET, TERMINAL_WAVE } from "../domain/types.js";

const WAVE_TRANSITIONS: Record<WaveStatus, WaveStatus[]> = {
  DRAFT: ["FROZEN", "CANCELLED"],
  FROZEN: ["RUNNING", "CANCELLED"],
  RUNNING: [
    "WAITING_APPROVAL",
    "PAUSED",
    "COMPLETED",
    "BLOCKED",
    "FAILED",
    "BUDGET_STOPPED",
    "CANCELLED",
  ],
  WAITING_APPROVAL: ["RUNNING", "PAUSED", "CANCELLED", "BLOCKED", "FAILED", "BUDGET_STOPPED"],
  PAUSED: ["RUNNING", "CANCELLED", "BUDGET_STOPPED"],
  COMPLETED: [],
  BLOCKED: [],
  FAILED: [],
  BUDGET_STOPPED: [],
  CANCELLED: [],
};

const TICKET_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  PENDING: ["CLAIMED", "CANCELLED", "BLOCKED", "BUDGET_STOPPED"],
  CLAIMED: ["PLANNING", "CANCELLED", "BLOCKED", "BUDGET_STOPPED"],
  PLANNING: ["PLAN_REVIEW", "FAILED", "CANCELLED", "BUDGET_STOPPED", "BLOCKED"],
  PLAN_REVIEW: ["APPROVED", "REVISING", "BLOCKED", "CANCELLED", "BUDGET_STOPPED"],
  APPROVED: ["IMPLEMENTING", "CANCELLED", "BUDGET_STOPPED", "BLOCKED"],
  REVISING: ["PLANNING", "CANCELLED", "BLOCKED", "BUDGET_STOPPED"],
  IMPLEMENTING: ["VERIFYING", "FAILED", "CANCELLED", "BUDGET_STOPPED", "BLOCKED"],
  VERIFYING: ["DONE", "FAILED", "CANCELLED", "BUDGET_STOPPED", "BLOCKED"],
  DONE: [],
  BLOCKED: [],
  FAILED: [],
  BUDGET_STOPPED: [],
  CANCELLED: [],
};

export const WAVE_OWNERS: Record<WaveStatus, string> = {
  DRAFT: "operator",
  FROZEN: "operator",
  RUNNING: "controller",
  WAITING_APPROVAL: "operator",
  PAUSED: "operator",
  COMPLETED: "none",
  BLOCKED: "operator",
  FAILED: "operator",
  BUDGET_STOPPED: "operator",
  CANCELLED: "none",
};

export const WAVE_NEXT: Record<WaveStatus, string> = {
  DRAFT: "freeze",
  FROZEN: "start",
  RUNNING: "tick",
  WAITING_APPROVAL: "approve-or-revise",
  PAUSED: "resume-or-cancel",
  COMPLETED: "inspect",
  BLOCKED: "inspect",
  FAILED: "inspect",
  BUDGET_STOPPED: "inspect",
  CANCELLED: "inspect",
};

export const TICKET_OWNERS: Record<TicketStatus, string> = {
  PENDING: "controller",
  CLAIMED: "controller",
  PLANNING: "plan-worker",
  PLAN_REVIEW: "operator",
  APPROVED: "controller",
  REVISING: "plan-worker",
  IMPLEMENTING: "impl-worker",
  VERIFYING: "verifier",
  DONE: "none",
  BLOCKED: "operator",
  FAILED: "operator",
  BUDGET_STOPPED: "operator",
  CANCELLED: "none",
};

export const TICKET_NEXT: Record<TicketStatus, string> = {
  PENDING: "claim",
  CLAIMED: "launch-plan",
  PLANNING: "wait-plan",
  PLAN_REVIEW: "approve-or-revise",
  APPROVED: "launch-impl",
  REVISING: "wait-plan",
  IMPLEMENTING: "wait-impl",
  VERIFYING: "wait-verify",
  DONE: "inspect",
  BLOCKED: "inspect",
  FAILED: "inspect",
  BUDGET_STOPPED: "inspect",
  CANCELLED: "inspect",
};

export function assertWaveTransition(
  from: WaveStatus,
  to: WaveStatus,
  cancelRequested: boolean,
): void {
  if (from === to) return;
  if (cancelRequested && to !== "CANCELLED" && !TERMINAL_WAVE.has(from)) {
    throw new CancelledError("sticky");
  }
  if (!WAVE_TRANSITIONS[from].includes(to)) {
    throw new WaveError(`Illegal wave transition ${from} → ${to}.`, "illegal_transition");
  }
}

export function assertTicketTransition(
  from: TicketStatus,
  to: TicketStatus,
  cancelRequested: boolean,
): void {
  if (from === to) return;
  if (cancelRequested && to !== "CANCELLED" && !TERMINAL_TICKET.has(from)) {
    throw new CancelledError("sticky");
  }
  if (!TICKET_TRANSITIONS[from].includes(to)) {
    throw new WaveError(`Illegal ticket transition ${from} → ${to}.`, "illegal_transition");
  }
}

export function assertExpectedRevision(actual: number, expected?: number): void {
  if (expected === undefined) return;
  if (actual !== expected) {
    throw new StaleRevisionError(expected, actual);
  }
}

export function isTerminalWave(status: WaveStatus): boolean {
  return TERMINAL_WAVE.has(status);
}

export function isTerminalTicket(status: TicketStatus): boolean {
  return TERMINAL_TICKET.has(status);
}
