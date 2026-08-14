import { parseFrontmatter, parseTicketFile } from "./markdown-tracker.js";

export type StudioKind = "game_jam" | "ai_mud" | "generic";

export type StudioMapping = {
  studio: StudioKind;
  ticketIdPattern: RegExp;
  issuesRel: string;
  defaultVerify?: string;
  statusMap: Record<string, string>;
  eligibilityField: string;
};

export const GAME_JAM: StudioMapping = {
  studio: "game_jam",
  ticketIdPattern: /^[A-Z]{2,}-\d+$/,
  issuesRel: "issues",
  defaultVerify: "python3 -m pytest -q",
  eligibilityField: "agent_eligible",
  statusMap: {
    open: "PENDING",
    scheduled: "PENDING",
    todo: "PENDING",
    ready: "PENDING",
    in_progress: "IMPLEMENTING",
    plan_review: "PLAN_REVIEW",
    blocked: "BLOCKED",
    done: "DONE",
    wontfix: "CANCELLED",
  },
};

export const AI_MUD: StudioMapping = {
  studio: "ai_mud",
  ticketIdPattern: /^MUD-\d+$/,
  issuesRel: "issues",
  defaultVerify: "./tools/verify_mud.sh",
  eligibilityField: "agent_eligible",
  statusMap: {
    open: "PENDING",
    scheduled: "PENDING",
    in_progress: "IMPLEMENTING",
    plan_review: "PLAN_REVIEW",
    blocked: "BLOCKED",
    done: "DONE",
    wontfix: "CANCELLED",
  },
};

export function detectStudio(repoPath: string, sampleId?: string): StudioMapping {
  if (sampleId?.startsWith("MUD-") || /ai-mud/.test(repoPath)) return AI_MUD;
  if (/game_jam/.test(repoPath)) return GAME_JAM;
  return GAME_JAM;
}

export function mapStudioStatus(mapping: StudioMapping, frontmatterStatus: string): string {
  return mapping.statusMap[frontmatterStatus.toLowerCase()] ?? "PENDING";
}

export function eligibleForBoundedWave(raw: string, mapping: StudioMapping): {
  eligible: boolean;
  reason: string;
} {
  const { data } = parseFrontmatter(raw);
  const status = String(data.status ?? "open").toLowerCase();
  if (["done", "wontfix"].includes(status)) {
    return { eligible: false, reason: "terminal" };
  }
  const eligibility = String(data.eligibility ?? "").toLowerCase();
  if (eligibility === "human_gated" || eligibility === "feature_done_gate") {
    return { eligible: false, reason: "human_gated" };
  }
  if (data.needs_jason) {
    return { eligible: false, reason: "needs_jason" };
  }
  const flag = data[mapping.eligibilityField];
  if (flag === false || flag === "false") {
    return { eligible: false, reason: "not agent_eligible" };
  }
  return { eligible: true, reason: "explicit-or-open" };
}

export function describeReplacementPath(): {
  old: string;
  next: string;
  overnight: string;
  drainEverything: false;
} {
  return {
    old: "clear the backlog / recurring drain ticks",
    next: "explicit bounded wave: freeze selected tickets → admit → PLAN → approve → IMPL → verify",
    overnight: "disabled until an operator explicitly revisits",
    drainEverything: false,
  };
}

export function readStudioTicket(repoPath: string, absPath: string) {
  return parseTicketFile(absPath, repoPath);
}
