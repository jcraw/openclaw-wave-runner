export type HumanHoldReason = "needs_jason" | "human_gated";

export type HumanHoldFields = {
  humanHold?: boolean;
  humanHoldReason?: HumanHoldReason;
};

const HOLD_TRUE = new Set(["true", "yes", "1", "hold", "required"]);
const HOLD_FALSE = new Set(["false", "0", "no", ""]);

/**
 * Wave hold for `needs_jason`. Boolean true / true-like strings only.
 * Annotations (`pick`, `opinion`, `review`) stay on the ticket and do not park the wave.
 */
export function needsJasonIsHold(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value == null) return false;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (HOLD_FALSE.has(v)) return false;
    return HOLD_TRUE.has(v);
  }
  return false;
}

/** Missing fields => agent auto-continue after PLAN (WR-023). */
export function resolveHumanHold(input: {
  needsJason?: unknown;
  eligibility?: unknown;
}): HumanHoldFields {
  if (needsJasonIsHold(input.needsJason)) {
    return { humanHold: true, humanHoldReason: "needs_jason" };
  }
  const elig = typeof input.eligibility === "string" ? input.eligibility.trim() : "";
  if (elig === "human_gated" || elig === "feature_done_gate") {
    return { humanHold: true, humanHoldReason: "human_gated" };
  }
  return {};
}
