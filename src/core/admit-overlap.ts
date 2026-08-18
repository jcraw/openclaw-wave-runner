import { deriveWriterScope } from "../domain/writer-scope.js";
import type { FrozenTicket } from "../domain/types.js";
import { scopePaths } from "../domain/scope-paths.js";
import type { WorkspaceAdapter } from "./ports.js";

export type AdmitBlocker = { ticketId: string; code: string; message: string };

export async function collectDirtyOverlapBlockers(
  workspace: WorkspaceAdapter,
  repoPath: string,
  tickets: FrozenTicket[],
): Promise<AdmitBlocker[]> {
  const overlapFn = workspace.primaryDirtyOverlap;
  if (!overlapFn) return [];
  const blockers: AdmitBlocker[] = [];
  for (const ticket of tickets) {
    const scope = ticket.writerScope || deriveWriterScope(ticket);
    const prefixes = scopePaths(scope, ticket.sourcePath);
    const { overlap } = await overlapFn.call(workspace, { repoPath, prefixes });
    if (!overlap.length) continue;
    blockers.push({
      ticketId: ticket.ticketId,
      code: "primary_dirty_overlap",
      message: `primary dirty overlaps ${scope}: ${overlap.join(", ")}`,
    });
  }
  return blockers;
}
