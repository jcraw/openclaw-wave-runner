import type { SupervisedStartOptions, TicketRun, WaveRecord, WaveView } from "../domain/types.js";
import { queueStage } from "./admission.js";
import { assertBudgetStatesForTerminal, markIndeterminate } from "./budget.js";
import type { ControllerContext } from "./controller-context.js";
import { inspect, refreshCounters, requireWave } from "./controller-context.js";
import {
  dispatchPending,
  expireStaleLeases,
  observeLaunched,
  reconcile,
  refreshHeldLeases,
} from "./launch.js";
import {
  isTerminalTicket,
  isTerminalWave,
  WAVE_NEXT,
  WAVE_OWNERS,
} from "./state-machine.js";
import { assertLaunchAllowed } from "./wave-create.js";

export function deadlineExceeded(ctrl: ControllerContext, wave: WaveRecord): boolean {
  const now = ctrl.clock.now();
  if (wave.stopAt !== undefined && now >= wave.stopAt) return true;
  if (wave.counters.startedAt !== undefined) {
    if (now - wave.counters.startedAt >= wave.limits.maxWallTimeMs) return true;
    if (wave.deadlineMs !== undefined && now - wave.counters.startedAt >= wave.deadlineMs) return true;
  }
  return false;
}

export function stopForBudget(ctrl: ControllerContext, waveId: string, reason: string): void {
  ctrl.db.transaction(() => {
    const wave = requireWave(ctrl, waveId);
    if (isTerminalWave(wave.status)) return;
    wave.status = "BUDGET_STOPPED";
    wave.owner = WAVE_OWNERS.BUDGET_STOPPED;
    wave.nextAction = WAVE_NEXT.BUDGET_STOPPED;
    wave.revision += 1;
    wave.updatedAt = ctrl.clock.now();
    ctrl.db.putWave(wave);
    for (const ticket of ctrl.db.listTickets(waveId)) {
      if (!isTerminalTicket(ticket.status)) {
        ticket.status = "BUDGET_STOPPED";
        ticket.result = reason;
        ticket.revision += 1;
        ctrl.db.putTicket(ticket);
      }
    }
    for (const budget of ctrl.db.listBudgets(waveId)) {
      if (budget.state === "RESERVED") {
        ctrl.db.putBudget(markIndeterminate(budget, ctrl.clock.now()));
      }
    }
    refreshCounters(ctrl, waveId);
  });
}

export function nextEligibleTicket(ctrl: ControllerContext, waveId: string): TicketRun | undefined {
  const tickets = ctrl.db.listTickets(waveId);
  const done = new Set(tickets.filter((t) => t.status === "DONE").map((t) => t.ticketId));
  return tickets.find(
    (ticket) =>
      (ticket.status === "PENDING" || ticket.status === "REVISING") &&
      ticket.dependsOn.every((dep) => done.has(dep)),
  );
}

export async function advanceReadyTickets(ctrl: ControllerContext, waveId: string): Promise<void> {
  const wave = requireWave(ctrl, waveId);
  if (wave.cancelRequested || isTerminalWave(wave.status) || wave.status === "WAITING_APPROVAL") {
    return;
  }
  const openOutbox = ctrl.db.listOutbox(waveId).some(
    (item) => item.state !== "SETTLED" && item.state !== "FAILED",
  );
  if (openOutbox) return;

  const approved = ctrl.db.listTickets(waveId).find((t) => t.status === "APPROVED");
  if (approved) {
    await queueStage(ctrl, waveId, approved.ticketId, "IMPL");
    return;
  }
  const inFlight = ctrl.db.listTickets(waveId).some((t) =>
    ["CLAIMED", "PLANNING", "IMPLEMENTING", "VERIFYING"].includes(t.status),
  );
  if (inFlight) return;
  const next = nextEligibleTicket(ctrl, waveId);
  if (next) {
    await queueStage(ctrl, waveId, next.ticketId, next.status === "REVISING" ? "PLAN" : "PLAN");
  }
}

export function maybeCompleteWave(ctrl: ControllerContext, waveId: string): void {
  ctrl.db.transaction(() => {
    const wave = requireWave(ctrl, waveId);
    if (isTerminalWave(wave.status)) return;
    const tickets = ctrl.db.listTickets(waveId);
    if (tickets.length === 0) return;
    if (!tickets.every((t) => isTerminalTicket(t.status))) return;
    const budgets = ctrl.db.listBudgets(waveId);
    assertBudgetStatesForTerminal(budgets);
    const failed = tickets.some((t) => t.status === "FAILED" || t.status === "BLOCKED" || t.status === "BUDGET_STOPPED");
    const cancelled = tickets.every((t) => t.status === "CANCELLED");
    wave.status = cancelled ? "CANCELLED" : failed ? "FAILED" : "COMPLETED";
    wave.owner = WAVE_OWNERS[wave.status];
    wave.nextAction = WAVE_NEXT[wave.status];
    wave.revision += 1;
    wave.updatedAt = ctrl.clock.now();
    ctrl.db.putWave(wave);
  });
}

export async function tickWave(
  ctrl: ControllerContext,
  waveId: string,
  options: SupervisedStartOptions = {},
): Promise<WaveView> {
  const wave = requireWave(ctrl, waveId);
  if (ctrl.launchMode !== "mock") {
    assertLaunchAllowed(ctrl, inspect(ctrl, waveId), options);
  }
  if (isTerminalWave(wave.status) || wave.status === "PAUSED") {
    return inspect(ctrl, waveId);
  }
  if (deadlineExceeded(ctrl, wave)) {
    stopForBudget(ctrl, waveId, "deadline");
    return inspect(ctrl, waveId);
  }
  refreshHeldLeases(ctrl, waveId);
  expireStaleLeases(ctrl);
  await reconcile(ctrl, waveId);
  if (requireWave(ctrl, waveId).status === "WAITING_APPROVAL") {
    return inspect(ctrl, waveId);
  }
  await dispatchPending(ctrl, waveId);
  await observeLaunched(ctrl, waveId);
  await advanceReadyTickets(ctrl, waveId);
  maybeCompleteWave(ctrl, waveId);
  return inspect(ctrl, waveId);
}

export async function runUntilIdle(
  ctrl: ControllerContext,
  waveId: string,
  maxSteps = 32,
  options: SupervisedStartOptions = {},
): Promise<WaveView> {
  for (let i = 0; i < maxSteps; i += 1) {
    const before = inspect(ctrl, waveId);
    await tickWave(ctrl, waveId, options);
    const after = inspect(ctrl, waveId);
    if (
      isTerminalWave(after.wave.status) ||
      after.wave.status === "WAITING_APPROVAL" ||
      after.wave.status === "PAUSED" ||
      (after.wave.revision === before.wave.revision &&
        after.tickets.every((t, idx) => t.revision === before.tickets[idx]?.revision) &&
        after.outbox.every((item) => item.state === "SETTLED" || item.state === "FAILED"))
    ) {
      break;
    }
  }
  return inspect(ctrl, waveId);
}
