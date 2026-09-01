import type { FrozenTicket } from "../domain/types.js";
import { deriveWriterScope } from "../domain/writer-scope.js";
import type { AdmitBlocker } from "./admit-overlap.js";
import { hopsExceedBlockers } from "./launch-hops.js";
import { codexPlanBlockers, planWorkerBlockers } from "./plan-worker.js";

function verifyMissing(ticket: FrozenTicket): boolean {
  return !ticket.verifyCommand?.trim();
}

export function collectAdmitBlockers(
  tickets: FrozenTicket[],
  maxLaunches?: number,
): AdmitBlocker[] {
  const blockers: AdmitBlocker[] = [];
  for (const ticket of tickets) {
    if (verifyMissing(ticket)) {
      blockers.push({
        ticketId: ticket.ticketId,
        code: "missing_verify",
        message: "verifyCommand is empty or missing",
      });
    }
    if (ticket.humanHold) {
      blockers.push({
        ticketId: ticket.ticketId,
        code: "human_hold",
        message: ticket.humanHoldReason ?? "human hold",
      });
    }
  }
  blockers.push(...planWorkerBlockers(tickets));
  blockers.push(...codexPlanBlockers(tickets));
  const byScope = new Map<string, string[]>();
  for (const ticket of tickets) {
    const scope = ticket.writerScope || deriveWriterScope(ticket);
    const ids = byScope.get(scope) ?? [];
    ids.push(ticket.ticketId);
    byScope.set(scope, ids);
  }
  for (const [scope, ids] of byScope) {
    if (ids.length < 2) continue;
    for (const ticketId of ids) {
      blockers.push({
        ticketId,
        code: "shared_writer_scope",
        message: `shares writer scope ${scope} with ${ids.filter((id) => id !== ticketId).join(", ")}`,
      });
    }
  }
  if (maxLaunches !== undefined) blockers.push(...hopsExceedBlockers(tickets, maxLaunches));
  return blockers;
}
