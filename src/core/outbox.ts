import { WaveError } from "../domain/errors.js";
import type { LaunchOutbox, OutboxState } from "../domain/types.js";

const OUTBOX_TRANSITIONS: Record<OutboxState, OutboxState[]> = {
  PENDING: ["CLAIMED", "FAILED"],
  CLAIMED: ["LAUNCHED", "RECONCILING", "FAILED"],
  LAUNCHED: ["SETTLED", "RECONCILING", "FAILED"],
  RECONCILING: ["LAUNCHED", "SETTLED", "FAILED"],
  SETTLED: [],
  FAILED: [],
};

export function assertOutboxTransition(from: OutboxState, to: OutboxState): void {
  if (from === to) return;
  if (!OUTBOX_TRANSITIONS[from].includes(to)) {
    throw new WaveError(`Illegal outbox transition ${from} → ${to}.`, "illegal_outbox");
  }
}

export function claimOutbox(
  item: LaunchOutbox,
  claimant: string,
  now: number,
): LaunchOutbox {
  assertOutboxTransition(item.state, "CLAIMED");
  return {
    ...item,
    state: "CLAIMED",
    claimedBy: claimant,
    claimedAt: now,
    updatedAt: now,
  };
}

export function markLaunched(item: LaunchOutbox, receiptJson: string, now: number): LaunchOutbox {
  assertOutboxTransition(item.state, "LAUNCHED");
  return {
    ...item,
    state: "LAUNCHED",
    receiptJson,
    updatedAt: now,
  };
}

export function markReconciling(item: LaunchOutbox, now: number): LaunchOutbox {
  assertOutboxTransition(item.state, "RECONCILING");
  return { ...item, state: "RECONCILING", updatedAt: now };
}

export function markSettled(item: LaunchOutbox, now: number): LaunchOutbox {
  assertOutboxTransition(item.state, "SETTLED");
  return { ...item, state: "SETTLED", updatedAt: now };
}

export function markFailed(item: LaunchOutbox, error: string, now: number): LaunchOutbox {
  assertOutboxTransition(item.state, "FAILED");
  return { ...item, state: "FAILED", error, updatedAt: now };
}

export type OutboxBoundary =
  | "before_reservation"
  | "after_reservation"
  | "after_launch"
  | "before_receipt_commit"
  | "after_completion"
  | "before_settlement";
