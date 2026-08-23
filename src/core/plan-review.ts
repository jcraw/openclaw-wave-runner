import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type PlanReviewCheck =
  | { ok: true; verdict: "approve" | "approve-with-conditions" | "revise" }
  | { ok: false; reason: string };

const VERDICT_RE = /(?:^|\n)\s*(?:\*\*)?Verdict(?:\*\*)?:\s*(approve-with-conditions|approve|revise)\b/i;

export function reviewFilePath(forgeRoot: string, ticketId: string): string {
  return join(forgeRoot, "reviews", `${ticketId}.md`);
}

export function checkPlanReview(input: { forgeRoot?: string; ticketId: string }): PlanReviewCheck {
  if (!input.forgeRoot) return { ok: false, reason: "missing_forge" };
  const path = reviewFilePath(input.forgeRoot, input.ticketId);
  if (!existsSync(path)) return { ok: false, reason: "missing_review" };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { ok: false, reason: "missing_review" };
  }
  if (!text.trim()) return { ok: false, reason: "review_theater" };
  const verdictRaw = text.match(VERDICT_RE)?.[1]?.toLowerCase();
  if (verdictRaw !== "approve" && verdictRaw !== "approve-with-conditions" && verdictRaw !== "revise") {
    return { ok: false, reason: "review_theater" };
  }
  if (!/^##\s+Cheat-mode scan\b/m.test(text) || !/^##\s+Learn\b/m.test(text)) {
    return { ok: false, reason: "review_theater" };
  }
  return { ok: true, verdict: verdictRaw };
}

export function checkPlanStamp(planText: string | undefined): boolean {
  if (!planText) return false;
  return /APPROVED by (Astra|Jason)\b/.test(planText);
}

export function resolveCrawmakForge(input: {
  explicit?: string;
  env?: NodeJS.Dict<string>;
  fromRepo?: string;
}): string | undefined {
  const env = input.env ?? process.env;
  const candidates = [input.explicit, env.CRAWMAK_FORGE, input.fromRepo ? join(input.fromRepo, "..", "crawmak") : undefined];
  for (const raw of candidates) {
    const path = raw?.trim();
    if (path && existsSync(join(path, "AGENTS.md"))) return path;
  }
  return undefined;
}
