import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { hashTicketContent, normalizeSelectedDependencies } from "../core/manifest.js";
import type { FrozenTicket, TicketSelector } from "../domain/types.js";
import type { TicketProjection, TrackerAdapter } from "./ports.js";

export type ParsedTicket = {
  ticketId: string;
  title: string;
  status: string;
  dependsOn: string[];
  planClass?: string;
  verifyCommand?: string;
  provider?: string;
  model?: string;
  sourcePath: string;
  body: string;
  raw: string;
};

export function parseFrontmatter(raw: string): { data: Record<string, string | string[] | boolean>; body: string } {
  if (!raw.startsWith("---")) return { data: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return { data: {}, body: raw };
  const block = raw.slice(4, end);
  const body = raw.slice(end + 4).replace(/^\n/, "");
  const data: Record<string, string | string[] | boolean> = {};
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes(":")) continue;
    const idx = trimmed.indexOf(":");
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (!key) continue;
    if (value.startsWith("[") && value.endsWith("]")) {
      data[key] = value
        .slice(1, -1)
        .split(",")
        .map((part) => part.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
      continue;
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value === "true" || value === "false") {
      data[key] = value === "true";
    } else {
      data[key] = value;
    }
  }
  return { data, body };
}

export function listMarkdownTickets(issuesRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".") || name.startsWith("_")) continue;
      const path = join(dir, name);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (name === "node_modules" || name === "tmp") continue;
        walk(path);
      } else if (name.endsWith(".md")) {
        const upper = name.toUpperCase();
        if (upper === "BOARD.MD" || upper === "ORCHESTRATION.MD" || upper === "OVERNIGHT_HANDOFF.MD") {
          continue;
        }
        out.push(path);
      }
    }
  };
  walk(issuesRoot);
  return out.sort();
}

export function parseTicketFile(path: string, repoRoot: string): ParsedTicket | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const { data, body } = parseFrontmatter(raw);
  const id = typeof data.id === "string" ? data.id : "";
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(id)) return undefined;
  const depends = Array.isArray(data.depends_on)
    ? data.depends_on.map(String)
    : typeof data.depends_on === "string" && data.depends_on
      ? data.depends_on.split(/[,\s]+/).filter(Boolean)
      : [];
  return {
    ticketId: id,
    title: typeof data.title === "string" ? data.title : id,
    status: typeof data.status === "string" ? data.status : "open",
    dependsOn: depends,
    planClass: typeof data.plan_class === "string" ? data.plan_class : undefined,
    verifyCommand:
      typeof data.verify === "string"
        ? data.verify
        : typeof data.verify_command === "string"
          ? data.verify_command
          : undefined,
    provider: typeof data.worker === "string" ? data.worker : undefined,
    model: typeof data.model === "string" ? data.model : undefined,
    sourcePath: relative(repoRoot, path),
    body,
    raw,
  };
}

export class MarkdownTracker implements TrackerAdapter {
  constructor(
    readonly repoRoot: string,
    readonly issuesRoot = join(repoRoot, "issues"),
  ) {}

  async snapshot(selection: TicketSelector): Promise<FrozenTicket[]> {
    const files = listMarkdownTickets(this.issuesRoot);
    const parsed = files
      .map((path) => parseTicketFile(path, this.repoRoot))
      .filter((ticket): ticket is ParsedTicket => Boolean(ticket));
    const byId = new Map(parsed.map((ticket) => [ticket.ticketId, ticket]));
    const selected = selection.ticketIds.map((id, index) => {
      const ticket = byId.get(id);
      if (!ticket) {
        throw new Error(`Ticket ${id} not found under ${this.issuesRoot}.`);
      }
      return {
        ticketId: ticket.ticketId,
        title: ticket.title,
        contentHash: hashTicketContent({
          ticketId: ticket.ticketId,
          title: ticket.title,
          body: ticket.body,
          dependsOn: ticket.dependsOn,
          sourcePath: ticket.sourcePath,
        }),
        dependsOn: ticket.dependsOn,
        order: index + 1,
        sourcePath: ticket.sourcePath,
        planClass: ticket.planClass,
        verifyCommand: ticket.verifyCommand,
        provider: ticket.provider,
        model: ticket.model,
      };
    });
    return normalizeSelectedDependencies(
      selected,
      parsed.map((ticket) => ({ ticketId: ticket.ticketId, status: ticket.status })),
    );
  }

  async mirror(update: TicketProjection): Promise<void> {
    const files = listMarkdownTickets(this.issuesRoot);
    for (const path of files) {
      const ticket = parseTicketFile(path, this.repoRoot);
      if (!ticket || ticket.ticketId !== update.ticketId) continue;
      const next = upsertFrontmatter(ticket.raw, {
        status: mapProjectedStatus(update.status),
        phase: update.phase?.toLowerCase(),
        wave_id: update.waveId,
        plan: update.plan,
        worker_out_dir: update.workerOutDir,
        report: update.proof,
      });
      writeFileSync(path, next, "utf8");
      return;
    }
  }
}

export function mapProjectedStatus(status: string): string {
  switch (status) {
    case "PLAN_REVIEW":
      return "plan_review";
    case "PLANNING":
    case "IMPLEMENTING":
    case "VERIFYING":
    case "CLAIMED":
    case "APPROVED":
    case "REVISING":
      return "in_progress";
    case "DONE":
      return "done";
    case "BLOCKED":
    case "BUDGET_STOPPED":
      return "blocked";
    case "CANCELLED":
    case "FAILED":
      return "blocked";
    default:
      return "open";
  }
}

export function upsertFrontmatter(
  raw: string,
  fields: Record<string, string | undefined>,
): string {
  const { data, body } = parseFrontmatter(raw);
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) data[key] = value;
  }
  const lines = Object.entries(data).map(([key, value]) => {
    if (Array.isArray(value)) return `${key}: [${value.join(", ")}]`;
    if (typeof value === "boolean") return `${key}: ${value}`;
    return `${key}: ${value}`;
  });
  return `---\n${lines.join("\n")}\n---\n\n${body.replace(/^\n/, "")}`;
}
