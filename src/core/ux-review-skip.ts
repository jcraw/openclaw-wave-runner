const TRUE_TOKENS = new Set(["true", "yes", "1"]);

function asString(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value.trim().toLowerCase();
  return "";
}

function isTrueToken(value: unknown): boolean {
  if (value === true || value === 1) return true;
  return TRUE_TOKENS.has(asString(value));
}

function isRequiredToken(value: unknown): boolean {
  return asString(value) === "required";
}

function firstPath(data: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Freeze-time UX bit only. Do not infer from labels, assignee, or planClass.
 */
export function resolveNeedsUx(data: Record<string, unknown> | undefined): boolean {
  if (!data) return false;
  if (isTrueToken(data.needs_ux) || isTrueToken(data.needsUx)) return true;
  if (isRequiredToken(data.ux_review) || isRequiredToken(data.uxReview)) return true;
  return false;
}

export function resolveUxSpecPath(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) return undefined;
  return firstPath(data, ["ux_spec_path", "uxSpecPath", "ux_spec", "uxSpec"]);
}

export function resolveUxReviewReviseCap(data: Record<string, unknown> | undefined): number | undefined {
  if (!data) return undefined;
  const raw = data.ux_review_revise_cap ?? data.uxReviewReviseCap;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : Number.NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Freeze manifest wins if the live row dropped needsUx (SP2 remain tick-20). */
export function liveNeedsUx(
  ticket: { ticketId: string; needsUx?: boolean },
  manifestJson?: string,
): boolean {
  if (ticket.needsUx === true) return true;
  if (!manifestJson) return false;
  try {
    const manifest = JSON.parse(manifestJson) as {
      tickets?: Array<{ ticketId?: string; needsUx?: boolean }>;
    };
    return manifest.tickets?.some((row) => row.ticketId === ticket.ticketId && row.needsUx === true) === true;
  } catch {
    return false;
  }
}

export function freezeUxFields(data: Record<string, unknown> | undefined): {
  needsUx?: true;
  uxSpecPath?: string;
  uxReviewReviseCap?: number;
} {
  if (!data) return {};
  const uxSpecPath = resolveUxSpecPath(data);
  const uxReviewReviseCap = resolveUxReviewReviseCap(data);
  return {
    ...(resolveNeedsUx(data) ? { needsUx: true as const } : {}),
    ...(uxSpecPath ? { uxSpecPath } : {}),
    ...(uxReviewReviseCap !== undefined ? { uxReviewReviseCap } : {}),
  };
}
