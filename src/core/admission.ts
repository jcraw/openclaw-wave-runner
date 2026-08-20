import { randomUUID } from "node:crypto";

import { WaveError } from "../domain/errors.js";
import type { StageName } from "../domain/types.js";
import { deriveWriterScope, writerLeaseKey } from "../domain/writer-scope.js";
import { claimantFields } from "./authority.js";
import { admitReservation, reservationCeiling } from "./budget.js";
import { CrashInjectedError, type ControllerContext } from "./controller-context.js";
import { refreshCounters, requireTicket, requireWave } from "./controller-context.js";
import { acquireLease } from "./lease.js";
import { assertTicketTransition, TICKET_NEXT, TICKET_OWNERS } from "./state-machine.js";

class AuthorityBusy extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "AuthorityBusy";
  }
}

export async function queueStage(
  ctrl: ControllerContext,
  waveId: string,
  ticketId: string,
  stage: StageName,
): Promise<void> {
  if (ctrl.crashAt === "before_reservation") {
    throw new CrashInjectedError("before_reservation");
  }
  const wave = requireWave(ctrl, waveId);
  if (wave.cancelRequested) {
    throw new WaveError("Cancellation forbids new child tasks.", "cancelled");
  }
  const ticket = requireTicket(ctrl, waveId, ticketId);
  const attempt = ctrl.db.listStages(waveId).filter((s) => s.ticketId === ticketId && s.stage === stage).length + 1;
  if (attempt - 1 > wave.limits.maxRetriesPerStage) {
    throw new WaveError("max_retries_per_stage exceeded.", "admission_denied");
  }
  const provider = ticket.provider ?? "mock";
  const activeProvider = ctrl.db
    .listOutbox(waveId)
    .filter((item) => item.state !== "SETTLED" && item.state !== "FAILED")
    .filter((item) => requireTicket(ctrl, waveId, item.ticketId).provider === provider).length;
  if (activeProvider >= wave.limits.perProviderConcurrency) {
    throw new WaveError("per-provider launch cap reached.", "admission_denied");
  }
  const ceiling = reservationCeiling(wave.limits);
  const idempotencyKey = `${waveId}:${ticketId}:${stage}:${attempt}`;
  if (ctrl.db.getOutboxByIdempotency(idempotencyKey)) return;

  let writerAuth: { resourceKey: string; scope: string } | undefined;
  try {
  ctrl.db.transaction(() => {
    const live = requireWave(ctrl, waveId);
    if (live.cancelRequested) throw new WaveError("Cancellation forbids new child tasks.", "cancelled");
    admitReservation({
      wave: live,
      entries: ctrl.db.listBudgets(waveId),
      candidateTokens: ceiling.tokens,
      candidateCostMicros: ceiling.costMicros,
      now: ctrl.clock.now(),
      extraLaunch: true,
    });
    if (stage === "IMPL") {
      const scope = ticket.writerScope || deriveWriterScope(ticket);
      const resourceKey = writerLeaseKey(live.repoPath, scope);
      const current = ctrl.db.getLease(resourceKey);
      const lease = acquireLease({
        current,
        resourceKey,
        now: ctrl.clock.now(),
        ttlMs: ctrl.leaseTtlMs,
        claimant: ctrl.process,
        waveId,
        ticketId,
      });
      const auth = ctrl.authority.tryAcquire({
        repoPath: live.repoPath,
        kind: "writer",
        scope,
        resourceKey,
        waveId,
        ticketId,
        now: ctrl.clock.now(),
        ttlMs: ctrl.leaseTtlMs,
        ...claimantFields(ctrl.process),
      });
      if (!auth.ok) throw new AuthorityBusy(auth.reason);
      writerAuth = { resourceKey, scope };
      ctrl.db.putLease(lease);
    }
    const now = ctrl.clock.now();
    const stageRunId = `${waveId}:stg:${randomUUID()}`;
    const budgetId = `${waveId}:bdg:${randomUUID()}`;
    const outboxId = `${waveId}:obx:${randomUUID()}`;
    const nextStatus = stage === "PLAN" ? "PLANNING" : stage === "IMPL" ? "IMPLEMENTING" : "VERIFYING";
    const fromStatus = requireTicket(ctrl, waveId, ticketId).status;
    if (fromStatus === "PENDING") {
      assertTicketTransition(fromStatus, "CLAIMED", live.cancelRequested);
      const t = requireTicket(ctrl, waveId, ticketId);
      t.status = "CLAIMED";
      t.revision += 1;
      ctrl.db.putTicket(t);
    }
    const t2 = requireTicket(ctrl, waveId, ticketId);
    assertTicketTransition(t2.status, nextStatus, live.cancelRequested);
    t2.status = nextStatus;
    t2.stage = stage;
    t2.owner = TICKET_OWNERS[nextStatus];
    t2.nextAction = TICKET_NEXT[nextStatus];
    t2.revision += 1;
    ctrl.db.putTicket(t2);
    ctrl.db.putStage({
      stageRunId,
      waveId,
      ticketId,
      stage,
      attempt,
      idempotencyKey,
      model: ticket.model,
      provider,
      status: "PENDING",
      createdAt: now,
    });
    ctrl.db.putBudget({
      budgetId,
      waveId,
      stageRunId,
      tokensReserved: ceiling.tokens,
      costReservedMicros: ceiling.costMicros,
      state: "RESERVED",
      createdAt: now,
      updatedAt: now,
    });
    ctrl.db.putOutbox({
      outboxId,
      waveId,
      ticketId,
      stage,
      attempt,
      idempotencyKey,
      state: "PENDING",
      fencingGeneration: ctrl.db.getLease(
        writerLeaseKey(live.repoPath, ticket.writerScope || deriveWriterScope(ticket)),
      )?.generation ?? 1,
      createdAt: now,
      updatedAt: now,
    });
    live.counters.launches += 1;
    ctrl.db.putWave(live);
    refreshCounters(ctrl, waveId);
  });
  } catch (err) {
    if (writerAuth) {
      try {
        ctrl.authority.release({
          repoPath: wave.repoPath,
          kind: "writer",
          scope: writerAuth.scope,
          resourceKey: writerAuth.resourceKey,
          ticketId,
          waveId,
        });
      } catch {
        /* rollback pair */
      }
    }
    if (err instanceof AuthorityBusy) return;
    throw err;
  }

  if (ctrl.crashAt === "after_reservation") {
    throw new CrashInjectedError("after_reservation");
  }
}
