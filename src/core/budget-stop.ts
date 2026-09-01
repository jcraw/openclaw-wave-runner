import { markIndeterminate } from "./budget.js";
import type { ControllerContext } from "./controller-context.js";
import { refreshCounters, requireWave } from "./controller-context.js";
import { releaseInactiveWriterLeases } from "./lease-release.js";
import { isTerminalTicket, isTerminalWave, WAVE_NEXT, WAVE_OWNERS } from "./state-machine.js";

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
