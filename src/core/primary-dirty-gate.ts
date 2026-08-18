import { deriveWriterScope } from "../domain/writer-scope.js";
import { scopePaths } from "../domain/scope-paths.js";
import type { ControllerContext } from "./controller-context.js";
import { refreshCounters, requireTicket, requireWave } from "./controller-context.js";
import { clipReason, primaryDirtyAllowed } from "./land-recovery.js";
import { TICKET_NEXT, TICKET_OWNERS } from "./state-machine.js";

/** Fail ticket with no outbox when primary dirt overlaps writer-scope prefixes. */
export async function failClosedIfPrimaryDirty(
  ctrl: ControllerContext,
  waveId: string,
  ticketId: string,
): Promise<boolean> {
  if (primaryDirtyAllowed()) return false;
  const overlapFn = ctrl.workspace.primaryDirtyOverlap;
  if (!overlapFn) return false;
  const wave = requireWave(ctrl, waveId);
  const ticket = requireTicket(ctrl, waveId, ticketId);
  const scope = ticket.writerScope || deriveWriterScope(ticket);
  const prefixes = scopePaths(scope, ticket.sourcePath);
  const { overlap } = await overlapFn.call(ctrl.workspace, {
    repoPath: wave.repoPath,
    prefixes,
  });
  if (!overlap.length) return false;
  ticket.status = "FAILED";
  ticket.result = clipReason(`primary_dirty_overlap: ${overlap.join(", ")}`);
  ticket.owner = TICKET_OWNERS.FAILED;
  ticket.nextAction = TICKET_NEXT.FAILED;
  ticket.revision += 1;
  ctrl.db.putTicket(ticket);
  refreshCounters(ctrl, waveId);
  return true;
}
