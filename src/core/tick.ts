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
import { failUnlaunchableApproved, releaseInactiveWriterLeases, writerLeaseBlocksImpl } from "./lease-release.js";
import { isIdleGateStatus } from "./operator-loop.js";
import { applyStageWatchdog } from "./stage-watchdog.js";
import { deriveWriterScope } from "../domain/writer-scope.js";
import {
  isTerminalTicket,
  isTerminalWave,
  TICKET_NEXT,
  TICKET_OWNERS,
  WAVE_NEXT,
  WAVE_OWNERS,
} from "./state-machine.js";
import { assertLaunchAllowed } from "./wave-create.js";

export function deadlineExceeded(ctrl: ControllerContext, wave: WaveRecord): boolean {
  const now = ctrl.clock.now();
  if (wave.stopAt !== undefined && now >= wave.stopAt) return true;
  // limits.maxWallTimeMs is schema leftover and must not stop a wave.
  // Only an explicit deadlineMs / stopAt is an elapsed-time kill.
  if (
    wave.deadlineMs !== undefined &&
    wave.deadlineMs > 0 &&
    wave.counters.startedAt !== undefined &&
    now - wave.counters.startedAt >= wave.deadlineMs
  ) {
    return true;
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
    releaseInactiveWriterLeases(ctrl, waveId);
  });
}

export function nextEligibleTicket(ctrl: ControllerContext, waveId: string): TicketRun | undefined {
  const tickets = ctrl.db.listTickets(waveId);
  // Only DONE satisfies a dep; FAILED/CANCELLED deps block launch, they do not complete the wave.
  const done = new Set(tickets.filter((t) => t.status === "DONE").map((t) => t.ticketId));
  return tickets.find(
    (ticket) =>
      (ticket.status === "PENDING" || ticket.status === "REVISING") &&
      ticket.dependsOn.every((dep) => done.has(dep)),
  );
}

function nearestDeadAncestor(
  ticket: TicketRun,
  byId: Map<string, TicketRun>,
  seen = new Set<string>(),
): TicketRun | undefined {
  if (seen.has(ticket.ticketId)) return undefined;
  seen.add(ticket.ticketId);
  for (const depId of ticket.dependsOn) {
    const dep = byId.get(depId);
    if (!dep) continue;
    if (dep.status === "CANCELLED" || dep.status === "FAILED") return dep;
    const upstream = nearestDeadAncestor(dep, byId, seen);
    if (upstream) return upstream;
  }
  return undefined;
}

function failDependentsOfDeadTickets(ctrl: ControllerContext, waveId: string): void {
  const wave = requireWave(ctrl, waveId);
  if (wave.cancelRequested || isTerminalWave(wave.status)) return;
  const tickets = ctrl.db.listTickets(waveId);
  const byId = new Map(tickets.map((ticket) => [ticket.ticketId, ticket]));
  const marks: Array<{ ticket: TicketRun; dead: TicketRun }> = [];
  for (const ticket of tickets) {
    if (isTerminalTicket(ticket.status)) continue;
    const dead = nearestDeadAncestor(ticket, byId);
    if (dead) marks.push({ ticket, dead });
  }
  for (const { ticket, dead } of marks) {
    ticket.status = "FAILED";
    ticket.result = dead.status === "CANCELLED"
      ? `dependency ${dead.ticketId} cancelled`
      : `dependency ${dead.ticketId} failed`;
    ticket.owner = TICKET_OWNERS.FAILED;
    ticket.nextAction = TICKET_NEXT.FAILED;
    ticket.revision += 1;
    ctrl.db.putTicket(ticket);
  }
}

export async function advanceReadyTickets(ctrl: ControllerContext, waveId: string): Promise<void> {
  const wave = requireWave(ctrl, waveId);
  if (wave.cancelRequested || isTerminalWave(wave.status) || isIdleGateStatus(wave.status)) {
    return;
  }

  const open = ctrl.db
    .listOutbox(waveId)
    .filter((item) => item.state !== "SETTLED" && item.state !== "FAILED");

  // Scopes already holding an IMPL outbox cannot take another IMPL (serial per scope).
  const busyImplScopes = new Set<string>();
  for (const item of open) {
    if (item.stage !== "IMPL") continue;
    const t = ctrl.db.getTicket(waveId, item.ticketId);
    if (!t) continue;
    busyImplScopes.add(t.writerScope || deriveWriterScope(t));
  }

  // 1) Queue all APPROVED IMPLs whose writer scope is free.
  let queued = 0;
  const approved = ctrl.db.listTickets(waveId).filter((t) => t.status === "APPROVED");
  for (const ticket of approved) {
    const scope = ticket.writerScope || deriveWriterScope(ticket);
    if (busyImplScopes.has(scope)) continue;
    if (writerLeaseBlocksImpl(ctrl, wave, ticket)) continue;
    try {
      await queueStage(ctrl, waveId, ticket.ticketId, "IMPL");
      busyImplScopes.add(scope);
      queued += 1;
    } catch (err) {
      // Preserve fail-closed admission errors when nothing is in flight.
      if (queued === 0 && open.length === 0) throw err;
      break;
    }
  }

  // 2) Queue PLAN for eligible tickets while under provider fan-out.
  // Do not block PLAN just because an unrelated scope is implementing (WR-011).
  const tickets = ctrl.db.listTickets(waveId);
  const done = new Set(tickets.filter((t) => t.status === "DONE").map((t) => t.ticketId));
  const planCandidates = tickets.filter(
    (ticket) =>
      (ticket.status === "PENDING" || ticket.status === "REVISING") &&
      ticket.dependsOn.every((dep) => done.has(dep)),
  );
  for (const ticket of planCandidates) {
    // Skip if this ticket already has open outbox work.
    if (open.some((item) => item.ticketId === ticket.ticketId)) continue;
    try {
      await queueStage(ctrl, waveId, ticket.ticketId, "PLAN");
      queued += 1;
    } catch (err) {
      if (queued === 0 && open.length === 0) throw err;
      break;
    }
  }
}

export function maybeCompleteWave(ctrl: ControllerContext, waveId: string): void {
  ctrl.db.transaction(() => {
    const wave = requireWave(ctrl, waveId);
    if (isTerminalWave(wave.status)) return;
    failDependentsOfDeadTickets(ctrl, waveId);
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
  if (isIdleGateStatus(requireWave(ctrl, waveId).status)) {
    return inspect(ctrl, waveId);
  }
  await dispatchPending(ctrl, waveId);
  await observeLaunched(ctrl, waveId);
  await applyStageWatchdog(ctrl, waveId);
  releaseInactiveWriterLeases(ctrl, waveId);
  await advanceReadyTickets(ctrl, waveId);
  failUnlaunchableApproved(ctrl, waveId);
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
      isIdleGateStatus(after.wave.status) ||
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
