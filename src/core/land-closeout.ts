import { randomUUID } from "node:crypto";

import { hashJson } from "../domain/hash.js";
import type { LaunchOutbox, TicketRun, WaveRecord } from "../domain/types.js";
import { deriveWriterScope, writerLeaseKey } from "../domain/writer-scope.js";
import type { ControllerContext } from "./controller-context.js";
import { refreshCounters, requireTicket, requireWave } from "./controller-context.js";
import { TICKET_NEXT, TICKET_OWNERS } from "./state-machine.js";

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

/** Explicit operator env only. Never infer push from repo path. */
export function shouldLandPush(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WAVE_LAND_PUSH === "1";
}

/** IMPL settle/land requires a live matching writer lease when one exists — and refuses a missing lease (expired). */
export function implFenceFailure(
  ctrl: ControllerContext,
  item: LaunchOutbox,
  ticket: TicketRun,
  wave: WaveRecord,
): string | undefined {
  if (item.stage !== "IMPL") return undefined;
  const scope = ticket.writerScope || deriveWriterScope(ticket);
  const lease = ctrl.db.getLease(writerLeaseKey(wave.repoPath, scope));
  if (!lease) return "stale_fence: writer lease missing";
  if (lease.generation !== item.fencingGeneration) {
    return `stale_fence: generation ${item.fencingGeneration} != ${lease.generation}`;
  }
  if (lease.ticketId && lease.ticketId !== ticket.ticketId) {
    return `stale_fence: lease held by ${lease.ticketId}`;
  }
  return undefined;
}

export async function finalizeImplLand(
  ctrl: ControllerContext,
  item: LaunchOutbox,
): Promise<void> {
  const waveId = item.waveId;
  const t = requireTicket(ctrl, waveId, item.ticketId);
  const wave = requireWave(ctrl, waveId);
  if (t.implWorktree && ctrl.workspace.landToMain) {
    const land = await ctrl.workspace.landToMain({
      repoPath: wave.repoPath,
      worktree: t.implWorktree,
      branch: t.implBranch,
      ticketId: t.ticketId,
      waveId,
      baseSha: wave.baseSha,
      push: shouldLandPush(),
    });
    ctrl.db.transaction(() => {
      const now = ctrl.clock.now();
      const ticket = requireTicket(ctrl, waveId, item.ticketId);
      if (land.ok) {
        putTicketStatus(
          ctrl,
          ticket,
          "DONE",
          land.commitSha ? `verified+landed ${land.commitSha.slice(0, 12)}` : "verified+landed",
        );
        ctrl.db.putArtifact({
          artifactId: `${waveId}:art:${randomUUID()}`,
          waveId,
          ticketId: item.ticketId,
          kind: "proof",
          path: land.proof,
          hash: hashJson(land.proof),
          createdAt: now,
        });
      } else {
        putTicketStatus(ctrl, ticket, "FAILED", clipReason(`land failed: ${land.error ?? "unknown"}`));
      }
      refreshCounters(ctrl, waveId);
    });
    return;
  }
  ctrl.db.transaction(() => {
    const ticket = requireTicket(ctrl, waveId, item.ticketId);
    if (ticket.status === "VERIFYING") {
      putTicketStatus(ctrl, ticket, "DONE", "verified");
      refreshCounters(ctrl, waveId);
    }
  });
}
