import { closeoutModeForWaveTicket } from "../domain/closeout-mode.js";
import type { LaunchOutbox, TicketRun } from "../domain/types.js";
import { applyOnExhaustedImpl } from "./apply-closeout.js";
import type { ControllerContext } from "./controller-context.js";
import { requireWave } from "./controller-context.js";
import { finalizeImplLand } from "./land-closeout.js";

function latestSettledImpl(
  ctrl: ControllerContext,
  waveId: string,
  ticketId: string,
): LaunchOutbox | undefined {
  const items = ctrl.db
    .listOutbox(waveId)
    .filter((item) => item.ticketId === ticketId && item.stage === "IMPL" && item.state === "SETTLED");
  items.sort((a, b) => b.attempt - a.attempt);
  return items[0];
}

function syntheticOutbox(ticket: TicketRun, from?: LaunchOutbox): LaunchOutbox {
  return (
    from ?? {
      outboxId: `${ticket.waveId}:obx:closeout:${ticket.ticketId}`,
      waveId: ticket.waveId,
      ticketId: ticket.ticketId,
      stage: "IMPL",
      attempt: 1,
      idempotencyKey: `${ticket.waveId}:${ticket.ticketId}:CLOSEOUT:1`,
      state: "SETTLED",
      fencingGeneration: 1,
      createdAt: 0,
      updatedAt: 0,
    }
  );
}

/**
 * Tick-owned closeout: VERIFYING + settled IMPL retries land/apply under the
 * shared land lock. Deferred contention stays VERIFYING. Durable successful
 * proof can finish without the impl worktree.
 */
export async function advancePendingCloseouts(ctrl: ControllerContext, waveId: string): Promise<void> {
  const wave = requireWave(ctrl, waveId);
  const tickets = ctrl.db.listTickets(waveId);
  for (const ticket of tickets) {
    if (ticket.status === "VERIFYING") {
      const settled = latestSettledImpl(ctrl, waveId, ticket.ticketId);
      await finalizeImplLand(ctrl, syntheticOutbox(ticket, settled));
      continue;
    }
    if (ticket.status !== "FAILED" || !ticket.implWorktree) continue;
    if ((ticket.result ?? "").includes("applied")) continue;
    if (closeoutModeForWaveTicket(wave.manifestJson, ticket.ticketId) !== "apply") continue;
    const settled = latestSettledImpl(ctrl, waveId, ticket.ticketId);
    await applyOnExhaustedImpl(ctrl, syntheticOutbox(ticket, settled));
  }
}
