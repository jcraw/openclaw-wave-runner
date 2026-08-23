const SKIP_TOKENS = new Set(["skip"]);
const TRUE_TOKENS = new Set(["true", "yes", "1"]);

function asString(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value.trim().toLowerCase();
  return "";
}

function isSkipToken(value: unknown): boolean {
  return SKIP_TOKENS.has(asString(value));
}

function isTrueToken(value: unknown): boolean {
  if (value === true || value === 1) return true;
  return TRUE_TOKENS.has(asString(value));
}

/**
 * Freeze-time skip only. Do not infer from verify command, plan length, or planClass.
 */
export function resolvePlanReviewSkip(data: Record<string, unknown> | undefined): boolean {
  if (!data) return false;
  if (isSkipToken(data.plan_review) || isSkipToken(data.planReview)) return true;
  if (isSkipToken(data.review)) return true;
  if (isTrueToken(data.review_skip) || isTrueToken(data.reviewSkip)) return true;
  if (isTrueToken(data.jason_skip) || isTrueToken(data.jasonSkip)) return true;
  return false;
}
