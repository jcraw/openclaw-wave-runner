export type HumanHoldReason = "needs_jason" | "human_gated";

export type HumanHoldFields = {
  humanHold?: boolean;
  humanHoldReason?: HumanHoldReason;
};

/** Missing fields => agent plan-gate (default). */
export function resolveHumanHold(input: {
  needsJason?: unknown;
  eligibility?: unknown;
}): HumanHoldFields {
  const needs = input.needsJason;
  if (needs === true) {
    return { humanHold: true, humanHoldReason: "needs_jason" };
  }
  if (typeof needs === "string" && needs.trim() && needs.trim().toLowerCase() !== "false") {
    return { humanHold: true, humanHoldReason: "needs_jason" };
  }
  const elig = typeof input.eligibility === "string" ? input.eligibility.trim() : "";
  if (elig === "human_gated" || elig === "feature_done_gate") {
    return { humanHold: true, humanHoldReason: "human_gated" };
  }
  return {};
}
