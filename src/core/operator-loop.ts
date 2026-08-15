import type { WaveStatus } from "../domain/types.js";

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
