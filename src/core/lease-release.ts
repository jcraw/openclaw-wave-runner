import type { LeaseRecord, TicketRun, TicketStatus, WaveRecord } from "../domain/types.js";
import { deriveWriterScope, writerLeaseKey } from "../domain/writer-scope.js";
import type { ControllerContext } from "./controller-context.js";
import { refreshCounters, requireWave } from "./controller-context.js";
import { releaseLease } from "./lease.js";
import { isTerminalTicket, TICKET_NEXT, TICKET_OWNERS } from "./state-machine.js";

const IMPL_ACTIVE: ReadonlySet<TicketStatus> = new Set(["IMPLEMENTING", "VERIFYING", "APPROVED"]);
const ACTIVE_WORK: ReadonlySet<TicketStatus> = new Set([
  "PENDING",
  "CLAIMED",
  "PLANNING",
  "IMPLEMENTING",
  "VERIFYING",
  "REVISING",
  "PLAN_REVIEW",
]);

export function isImplActive(status: TicketStatus): boolean {
  return IMPL_ACTIVE.has(status);
}

function weHold(ctrl: ControllerContext, lease: LeaseRecord): boolean {
  return lease.holder === ctrl.process.holder && lease.processIdentity === ctrl.process.processIdentity;
}

function holderTicket(ctrl: ControllerContext, lease: LeaseRecord, waveId: string): TicketRun | undefined {
  if (!lease.ticketId) return undefined;
  const id = lease.waveId && lease.waveId !== waveId ? lease.waveId : waveId;
  return ctrl.db.getTicket(id, lease.ticketId);
}

function authorityKind(resourceKey: string): "writer" | "land" {
  return resourceKey.startsWith("land:") ? "land" : "writer";
}

function writerScopeFromKey(resourceKey: string, repoPath: string): string | undefined {
  const prefix = `writer:${repoPath}:`;
  if (!resourceKey.startsWith(prefix)) return undefined;
  return resourceKey.slice(prefix.length);
}

export function releaseAuthorityForLease(ctrl: ControllerContext, lease: LeaseRecord): void {
  const wave = lease.waveId ? ctrl.db.getWave(lease.waveId) : undefined;
  if (!wave || !lease.ticketId || !lease.waveId) return;
  const kind = authorityKind(lease.resourceKey);
  const scope = kind === "writer" ? writerScopeFromKey(lease.resourceKey, wave.repoPath) : undefined;
  try {
    ctrl.authority.release({
      repoPath: wave.repoPath,
      kind,
      ...(scope ? { scope } : {}),
      resourceKey: lease.resourceKey,
      ticketId: lease.ticketId,
      waveId: lease.waveId,
    });
  } catch {
    /* authority then sqlite */
  }
}

function tryRelease(ctrl: ControllerContext, lease: LeaseRecord): boolean {
  if (!weHold(ctrl, lease)) return false;
  releaseAuthorityForLease(ctrl, lease);
  try {
    releaseLease({
      current: lease,
      claimant: ctrl.process,
      expectedGeneration: lease.generation,
      now: ctrl.clock.now(),
    });
    ctrl.db.deleteLease(lease.resourceKey);
    return true;
  } catch {
    return false;
  }
}

/** Idempotent. Releases this ticket's writer lease when it is no longer IMPL-active. */
export function releaseWriterLeaseIfHeld(ctrl: ControllerContext, wave: WaveRecord, ticket: TicketRun): void {
  if (isImplActive(ticket.status)) return;
  const scope = ticket.writerScope || deriveWriterScope(ticket);
  const lease = ctrl.db.getLease(writerLeaseKey(wave.repoPath, scope));
  if (!lease) return;
  if (lease.ticketId && lease.ticketId !== ticket.ticketId) return;
  tryRelease(ctrl, lease);
}

/** Sweep leases listed on this wave whose holder ticket is missing or not IMPL-active. */
export function releaseInactiveWriterLeases(ctrl: ControllerContext, waveId: string): void {
  for (const lease of ctrl.db.listLeases(waveId)) {
    if (!weHold(ctrl, lease)) continue;
    const ticket = holderTicket(ctrl, lease, waveId);
    if (ticket && isImplActive(ticket.status)) continue;
    tryRelease(ctrl, lease);
  }
}

/**
 * A same-scope IMPL is blocked when another live holder has the key.
 * Terminal-held leases we own are deleted and treated as free.
 */
export function writerLeaseBlocksImpl(ctrl: ControllerContext, wave: WaveRecord, ticket: TicketRun): boolean {
  const scope = ticket.writerScope || deriveWriterScope(ticket);
  const resourceKey = writerLeaseKey(wave.repoPath, scope);
  const lease = ctrl.db.getLease(resourceKey);
  if (lease && lease.ticketId) {
    const sameHolder =
      lease.ticketId === ticket.ticketId && (!lease.waveId || lease.waveId === wave.waveId);
    if (!sameHolder) {
      const holder = holderTicket(ctrl, lease, wave.waveId);
      if (weHold(ctrl, lease) && (!holder || isTerminalTicket(holder.status))) {
        tryRelease(ctrl, lease);
      } else {
        return true;
      }
    }
  }
  const held = ctrl.authority.heldBy({
    repoPath: wave.repoPath,
    kind: "writer",
    scope,
    resourceKey,
    now: ctrl.clock.now(),
  });
  return Boolean(
    held &&
      (held.ticketId !== ticket.ticketId || held.waveId !== wave.waveId) &&
      held.expiresAt > ctrl.clock.now(),
  );
}

function liveForeignOrSiblingLease(
  ctrl: ControllerContext,
  wave: WaveRecord,
  ticket: TicketRun,
): boolean {
  const scope = ticket.writerScope || deriveWriterScope(ticket);
  const lease = ctrl.db.getLease(writerLeaseKey(wave.repoPath, scope));
  if (!lease) return false;
  if (lease.ticketId === ticket.ticketId) return true;
  const holder = holderTicket(ctrl, lease, wave.waveId);
  if (holder && isImplActive(holder.status)) return true;
  if (!weHold(ctrl, lease)) return true;
  if (lease.waveId && lease.waveId !== wave.waveId && (!holder || isImplActive(holder.status))) return true;
  return false;
}

/** Leftover APPROVED blocked only by a terminal-held lease → FAILED. Live foreign leases wait. */
export function failUnlaunchableApproved(ctrl: ControllerContext, waveId: string): void {
  ctrl.db.transaction(() => {
    const wave = requireWave(ctrl, waveId);
    if (wave.status !== "RUNNING") return;
    const tickets = ctrl.db.listTickets(waveId);
    if (tickets.some((t) => ACTIVE_WORK.has(t.status))) return;
    const open = ctrl.db
      .listOutbox(waveId)
      .filter((item) => item.state !== "SETTLED" && item.state !== "FAILED");
    if (open.length) return;
    const approved = tickets.filter((t) => t.status === "APPROVED");
    if (approved.length === 0) return;
    let marked = false;
    for (const ticket of approved) {
      if (liveForeignOrSiblingLease(ctrl, wave, ticket)) continue;
      ticket.status = "FAILED";
      ticket.result = "unlaunchable: no progress";
      ticket.owner = TICKET_OWNERS.FAILED;
      ticket.nextAction = TICKET_NEXT.FAILED;
      ticket.revision += 1;
      ctrl.db.putTicket(ticket);
      marked = true;
    }
    if (marked) refreshCounters(ctrl, waveId);
  });
}
