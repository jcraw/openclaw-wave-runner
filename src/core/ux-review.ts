import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type { LaunchOutbox, TicketRun } from "../domain/types.js";
import type { ControllerContext } from "./controller-context.js";
import { requireWave } from "./controller-context.js";
import { resolveCrawmakForge } from "./plan-review.js";

export type UxReviewCheck =
  | { ok: true; verdict: "approve" | "approve-with-conditions" | "revise" }
  | { ok: false; reason: string };

const VERDICT_RE = /(?:^|\n)\s*(?:\*\*)?Verdict(?:\*\*)?:\s*(approve-with-conditions|approve|revise)\b/i;
const PLAN_SPEC_RE = /^(?:UX spec|ux_spec)\s*:\s*(\S+)/m;

export function uxReviewFilePath(monaRoot: string, ticketId: string): string {
  return join(monaRoot, "reviews", `${ticketId}-ux.md`);
}

export function checkUxReview(input: { monaRoot?: string; ticketId: string }): UxReviewCheck {
  if (!input.monaRoot) return { ok: false, reason: "missing_mona" };
  const path = uxReviewFilePath(input.monaRoot, input.ticketId);
  if (!existsSync(path)) return { ok: false, reason: "missing_ux_review" };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { ok: false, reason: "missing_ux_review" };
  }
  if (!text.trim()) return { ok: false, reason: "ux_review_theater" };
  const verdictRaw = text.match(VERDICT_RE)?.[1]?.toLowerCase();
  if (verdictRaw !== "approve" && verdictRaw !== "approve-with-conditions" && verdictRaw !== "revise") {
    return { ok: false, reason: "ux_review_theater" };
  }
  return { ok: true, verdict: verdictRaw };
}

export function parseUxSpecFromPlan(planText: string | undefined): string | undefined {
  if (!planText) return undefined;
  const match = planText.match(PLAN_SPEC_RE)?.[1]?.trim();
  return match || undefined;
}

function nonEmptyFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile() && readFileSync(path, "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

export function resolveExistingUxSpec(input: {
  frozenPath?: string;
  planText?: string;
  searchRoots: Array<string | undefined>;
}): string | undefined {
  const raw = input.frozenPath?.trim() || parseUxSpecFromPlan(input.planText);
  if (!raw) return undefined;
  if (isAbsolute(raw)) return nonEmptyFile(raw) ? raw : undefined;
  for (const root of input.searchRoots) {
    if (!root) continue;
    const candidate = join(root, raw);
    if (nonEmptyFile(candidate)) return candidate;
  }
  return undefined;
}

export function resolveMonaWorkspace(input: {
  explicit?: string;
  env?: NodeJS.Dict<string>;
}): string | undefined {
  const env = input.env ?? process.env;
  const fallback = join("/run", "media", "j", "M2MegaStore", "Code", "Ai", "mona");
  const candidates = [input.explicit, env.MONA_ROOT, fallback];
  for (const raw of candidates) {
    const path = raw?.trim();
    if (path && existsSync(join(path, "AGENTS.md"))) return path;
  }
  return undefined;
}

export function launchCwd(
  ctrl: ControllerContext,
  item: Pick<LaunchOutbox, "stage" | "waveId">,
  ticket: Pick<TicketRun, "implWorktree">,
): string | undefined {
  if (item.stage === "REVIEW") {
    return resolveCrawmakForge({
      explicit: ctrl.forgeRoot,
      fromRepo: requireWave(ctrl, item.waveId).repoPath,
    });
  }
  if (item.stage === "UX_REVIEW") {
    return resolveMonaWorkspace({ explicit: ctrl.monaRoot });
  }
  return ticket.implWorktree;
}

