import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { closeoutModeForWaveTicket } from "../domain/closeout-mode.js";
import { hashJson } from "../domain/hash.js";
import type { LaunchOutbox, TicketRun, WaveRecord } from "../domain/types.js";
import { deriveWriterScope, writerLeaseKey } from "../domain/writer-scope.js";
import { executeApplyCloseout } from "./apply-closeout.js";
import { durableTicketProofPath, readDurableOk } from "./closeout-proof.js";
import type { ControllerContext } from "./controller-context.js";
import { refreshCounters, requireTicket, requireWave } from "./controller-context.js";
import { acquireExclusiveLandLock, releaseExclusiveLandLock } from "./land-lock.js";
import { closeoutDebtReason } from "./land-recovery.js";
import { releaseWriterLeaseIfHeld } from "./lease-release.js";
import type { LandResult } from "./ports.js";
import { TICKET_NEXT, TICKET_OWNERS } from "./state-machine.js";

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

function failLand(ctrl: ControllerContext, waveId: string, ticketId: string, reason: string): void {
  ctrl.db.transaction(() => {
    const ticket = requireTicket(ctrl, waveId, ticketId);
    putTicketStatus(ctrl, ticket, "FAILED", closeoutDebtReason(reason));
    refreshCounters(ctrl, waveId);
  });
}

function recordProofArtifact(
  ctrl: ControllerContext,
  waveId: string,
  ticketId: string,
  path: string,
  kind: string,
  hashSource: unknown,
): void {
  ctrl.db.putArtifact({
    artifactId: `${waveId}:art:${randomUUID()}`,
    waveId,
    ticketId,
    kind,
    path,
    hash: hashJson(hashSource),
    createdAt: ctrl.clock.now(),
  });
}

export function releaseWriterLeaseAfterLand(ctrl: ControllerContext, item: LaunchOutbox): void {
  const ticket = requireTicket(ctrl, item.waveId, item.ticketId);
  const wave = requireWave(ctrl, item.waveId);
  releaseWriterLeaseIfHeld(ctrl, wave, ticket);
}

function recordCommitLand(
  ctrl: ControllerContext,
  waveId: string,
  ticketId: string,
  land: LandResult,
): void {
  ctrl.db.transaction(() => {
    const live = requireTicket(ctrl, waveId, ticketId);
    if (land.ok && land.proof && existsSync(land.proof)) {
      putTicketStatus(
        ctrl,
        live,
        "DONE",
        land.commitSha ? `verified+landed ${land.commitSha.slice(0, 12)}` : "verified+landed",
      );
      recordProofArtifact(ctrl, waveId, ticketId, land.proof, "proof", land.proof);
    } else if (land.ok) {
      putTicketStatus(ctrl, live, "FAILED", closeoutDebtReason("missing LAND.json"));
    } else {
      putTicketStatus(ctrl, live, "FAILED", closeoutDebtReason(land.error ?? "unknown", land.proof));
      if (land.recovery) {
        recordProofArtifact(ctrl, waveId, ticketId, land.proof, "land-recovery", land.recovery);
      }
    }
    refreshCounters(ctrl, waveId);
  });
}

function landProofPath(ctrl: ControllerContext, wave: WaveRecord, ticket: TicketRun): string {
  return durableTicketProofPath({
    repoPath: wave.repoPath,
    ...(ctrl.artifactRoot ? { artifactRoot: ctrl.artifactRoot } : {}),
    waveId: wave.waveId,
    ticketId: ticket.ticketId,
    file: "LAND.json",
  });
}

function applyProofPath(ctrl: ControllerContext, wave: WaveRecord, ticket: TicketRun): string {
  return durableTicketProofPath({
    repoPath: wave.repoPath,
    ...(ctrl.artifactRoot ? { artifactRoot: ctrl.artifactRoot } : {}),
    waveId: wave.waveId,
    ticketId: ticket.ticketId,
    file: "APPLY.json",
  });
}

function finishFromDurableProof(
  ctrl: ControllerContext,
  item: LaunchOutbox,
  wave: WaveRecord,
  ticket: TicketRun,
): boolean {
  const mode = closeoutModeForWaveTicket(wave.manifestJson, ticket.ticketId);
  if (mode === "apply") {
    const proof = applyProofPath(ctrl, wave, ticket);
    if (!readDurableOk(proof)) return false;
    ctrl.db.transaction(() => {
      const live = requireTicket(ctrl, item.waveId, item.ticketId);
      if (live.status === "DONE") return;
      putTicketStatus(ctrl, live, "DONE", "verified+applied");
      recordProofArtifact(ctrl, item.waveId, item.ticketId, proof, "proof", proof);
      refreshCounters(ctrl, item.waveId);
    });
    releaseWriterLeaseAfterLand(ctrl, item);
    return true;
  }
  const proof = landProofPath(ctrl, wave, ticket);
  if (!readDurableOk(proof)) return false;
  let parsed: { commitSha?: string } = {};
  try {
    parsed = JSON.parse(readFileSync(proof, "utf8")) as { commitSha?: string };
  } catch {
    parsed = {};
  }
  ctrl.db.transaction(() => {
    const live = requireTicket(ctrl, item.waveId, item.ticketId);
    if (live.status === "DONE") return;
    putTicketStatus(
      ctrl,
      live,
      "DONE",
      parsed.commitSha ? `verified+landed ${parsed.commitSha.slice(0, 12)}` : "verified+landed",
    );
    recordProofArtifact(ctrl, item.waveId, item.ticketId, proof, "proof", proof);
    refreshCounters(ctrl, item.waveId);
  });
  releaseWriterLeaseAfterLand(ctrl, item);
  return true;
}

export async function finalizeImplLand(
  ctrl: ControllerContext,
  item: LaunchOutbox,
): Promise<void> {
  const waveId = item.waveId;
  const wave = requireWave(ctrl, waveId);
  const ticket = requireTicket(ctrl, waveId, item.ticketId);
  if (ticket.status === "DONE") return;
  if (finishFromDurableProof(ctrl, item, wave, ticket)) return;
  const got = await acquireExclusiveLandLock(ctrl, wave, item.ticketId);
  if (!got.ok) {
    // Deferred: keep VERIFYING and the writer lease. Tick retries.
    return;
  }
  try {
    const live = requireTicket(ctrl, waveId, item.ticketId);
    if (live.status === "DONE") return;
    if (finishFromDurableProof(ctrl, item, wave, live)) return;
    if (!live.implWorktree) {
      failLand(ctrl, waveId, item.ticketId, "missing impl worktree");
      return;
    }
    const mode = closeoutModeForWaveTicket(wave.manifestJson, live.ticketId);
    if (mode === "apply") {
      await executeApplyCloseout(ctrl, item, wave, live, { doneOnOk: true });
      return;
    }
    if (!ctrl.workspace.landToMain) {
      failLand(ctrl, waveId, item.ticketId, "landToMain missing");
      return;
    }
    const land = await ctrl.workspace.landToMain({
      repoPath: wave.repoPath,
      worktree: live.implWorktree,
      branch: live.implBranch,
      ticketId: live.ticketId,
      waveId,
      baseSha: wave.baseSha,
      push: shouldLandPush(),
      ...(ctrl.artifactRoot ? { artifactRoot: ctrl.artifactRoot } : {}),
    });
    recordCommitLand(ctrl, waveId, item.ticketId, land);
  } finally {
    releaseExclusiveLandLock(ctrl, wave, item.ticketId, got.generation);
    const after = ctrl.db.getTicket(waveId, item.ticketId);
    if (after && after.status !== "VERIFYING") {
      releaseWriterLeaseAfterLand(ctrl, item);
    }
  }
}

/** P1: re-run landToMain with no stash. Operator must clear overlap first. */
export async function retryImplLand(
  ctrl: ControllerContext,
  waveId: string,
  ticketId: string,
): Promise<LandResult> {
  const ticket = requireTicket(ctrl, waveId, ticketId);
  const missing: LandResult = {
    ok: false,
    proof: "",
    error: "land-retry refused: ticket not FAILED with impl worktree",
  };
  if (ticket.status !== "FAILED" || !ticket.implWorktree || !ctrl.workspace.landToMain) {
    return missing;
  }
  const item: LaunchOutbox = {
    outboxId: `${waveId}:obx:land-retry:${ticketId}`,
    waveId,
    ticketId,
    stage: "IMPL",
    attempt: 1,
    idempotencyKey: `${waveId}:${ticketId}:LAND_RETRY:1`,
    state: "SETTLED",
    fencingGeneration: 1,
    createdAt: ctrl.clock.now(),
    updatedAt: ctrl.clock.now(),
  };
  await finalizeImplLand(ctrl, item);
  const live = requireTicket(ctrl, waveId, ticketId);
  if (live.status === "DONE") {
    return { ok: true, proof: live.result ?? "", commitSha: live.result };
  }
  return { ok: false, proof: "", error: live.result ?? "land-retry failed" };
}
