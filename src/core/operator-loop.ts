import { hashJson } from "../domain/hash.js";
import type { WaveStatus } from "../domain/types.js";

export type ProgressView = {
  wave: { status: WaveStatus };
  tickets: Array<{ ticketId: string; status: string; revision: number; result?: string }>;
  outbox: Array<{ outboxId: string; state: string }>;
  leases: Array<{ resourceKey: string; holder: string; ticketId?: string }>;
};

export type OperatorLoopDecision =
  | "tick"
  | "wait_plan_gate"
  | "stop_human"
  | "stop_paused"
  | "stop_terminal"
  | "start";

/**
 * Pure operator loop contract (WR-008).
 * - AWAITING_PLAN_GATE: stay alive; do not exit; wait for Astra approve/revise
 * - WAITING_APPROVAL: human hold — OPERATOR_STOP
 */
export function operatorLoopDecision(status: WaveStatus): OperatorLoopDecision {
  switch (status) {
    case "DRAFT":
    case "FROZEN":
      return "start";
    case "RUNNING":
      return "tick";
    case "AWAITING_PLAN_GATE":
      return "wait_plan_gate";
    case "WAITING_APPROVAL":
      return "stop_human";
    case "PAUSED":
      return "stop_paused";
    default:
      return "stop_terminal";
  }
}

export function isIdleGateStatus(status: WaveStatus): boolean {
  return status === "AWAITING_PLAN_GATE" || status === "WAITING_APPROVAL";
}

/** Stable progress hash: wave status + ticket/outbox/lease identity fields. */
export function progressFingerprint(view: ProgressView): string {
  return hashJson({
    status: view.wave.status,
    tickets: [...view.tickets]
      .map((t) => ({
        id: t.ticketId,
        status: t.status,
        revision: t.revision,
        result: t.result ?? "",
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    outbox: [...view.outbox]
      .map((item) => ({ id: item.outboxId, state: item.state }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    leases: [...view.leases]
      .map((lease) => ({
        key: lease.resourceKey,
        holder: lease.holder,
        ticketId: lease.ticketId ?? "",
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  });
}

export const LIVE_OUTBOX_STATES = ["CLAIMED", "LAUNCHED", "RECONCILING"] as const;

/** True when any outbox is still in flight (healthy long IMPL is not stuck). */
export function hasLiveOutbox(view: ProgressView): boolean {
  return view.outbox.some((item) =>
    item.state === "CLAIMED" || item.state === "LAUNCHED" || item.state === "RECONCILING",
  );
}

/**
 * Increment only while RUNNING, fingerprint unchanged, and no live outbox.
 * Live CLAIMED/LAUNCHED/RECONCILING resets (WR-020). Frozen RUNNING with
 * no open outbox still stops (WR-019). threshold <= 0 disables the stop.
 */
export function nextStuckCount(
  prev: string,
  next: string,
  n: number,
  threshold: number,
  status: WaveStatus,
  live = false,
): { count: number; stuck: boolean } {
  if (status !== "RUNNING") return { count: 0, stuck: false };
  if (live) return { count: 0, stuck: false };
  if (next !== prev) return { count: 0, stuck: false };
  const count = n + 1;
  return { count, stuck: threshold > 0 && count >= threshold };
}
