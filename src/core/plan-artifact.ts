export type PlanArtifactOk = { ok: true };
export type PlanArtifactFail = { ok: false; reason: string };
export type PlanArtifactResult = PlanArtifactOk | PlanArtifactFail;

const MIN_CHARS = 24;
const BLOCK_HEADING = /^(?:#{1,6}\s*)?(BLOCKED|NEEDS_JASON)\b/im;

function isFixtureVerify(verify: string | undefined): boolean {
  if (!verify) return true;
  const v = verify.trim().toLowerCase();
  return v === "" || v === "true";
}

/** Script plan-gate. Fail closed; do not ask an LLM. */
export function checkPlanArtifact(input: {
  planText: string;
  ticketId: string;
  verifyCommand?: string;
}): PlanArtifactResult {
  const text = input.planText.trim();
  if (text.length < MIN_CHARS) return { ok: false, reason: "tiny or missing PLAN.md" };
  if (BLOCK_HEADING.test(text)) return { ok: false, reason: "plan headed BLOCKED/NEEDS_JASON" };
  if (input.ticketId && !text.includes(input.ticketId)) {
    return { ok: false, reason: `plan missing ticket id ${input.ticketId}` };
  }
  const verify = input.verifyCommand?.trim();
  if (!isFixtureVerify(verify) && verify && !text.includes(verify)) {
    return { ok: false, reason: "plan missing verify command" };
  }
  return { ok: true };
}
