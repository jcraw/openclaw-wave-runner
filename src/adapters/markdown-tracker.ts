import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

import { resolveHumanHold } from "../core/human-hold.js";
import { parseCloseoutMode } from "../domain/closeout-mode.js";
import { deriveWriterScope } from "../domain/writer-scope.js";
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
  humanHold?: boolean;
  humanHoldReason?: "needs_jason" | "human_gated";
  product?: string;
  game?: string;
  writerScope?: string;
  landMode?: "apply" | "commit";
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

const TICKET_ID_RE = /^[A-Z][A-Z0-9]*-\d+$/;
const TICKET_ID_PREFIX_RE = /^([A-Z][A-Z0-9]*-\d+)/;

function firstScalar(
  data: Record<string, string | string[] | boolean>,
  keys: string[],
): string | boolean | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function firstStringList(
  data: Record<string, string | string[] | boolean>,
  keys: string[],
): string[] {
  for (const key of keys) {
    if (!(key in data)) continue;
    const value = data[key];
    if (Array.isArray(value)) return value.map(String);
    if (typeof value === "string") return value ? value.split(/[,\s]+/).filter(Boolean) : [];
  }
  return [];
}

function ticketIdFromPath(path: string): string | undefined {
  return TICKET_ID_PREFIX_RE.exec(basename(path).replace(/\.md$/i, ""))?.[1];
}

function titleFromPath(path: string, ticketId: string): string {
  const base = basename(path).replace(/\.md$/i, "");
  const prefix = `${ticketId}-`;
  return base.startsWith(prefix) && base.length > prefix.length ? base.slice(prefix.length) : base;
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

function yamlVerifyCommand(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value === true) return "true";
  if (value === false) return "false";
  return undefined;
}

export function parseTicketFile(path: string, repoRoot: string): ParsedTicket | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const { data, body } = parseFrontmatter(raw);
  const idRaw = firstScalar(data, ["id", "ticket", "issue"]);
  const ticketId =
    typeof idRaw === "string" && TICKET_ID_RE.test(idRaw) ? idRaw : ticketIdFromPath(path);
  if (!ticketId) return undefined;
  const titleRaw = firstScalar(data, ["title", "name", "summary"]);
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const title =
    (typeof titleRaw === "string" && titleRaw) || heading || titleFromPath(path, ticketId) || ticketId;
  const statusRaw = firstScalar(data, ["status", "state"]);
  const hold = resolveHumanHold({
    needsJason: data.needs_jason,
    eligibility: data.eligibility,
  });
  const product = typeof data.product === "string" ? data.product : undefined;
  const game = typeof data.game === "string" ? data.game : undefined;
  const sourcePath = relative(repoRoot, path);
  const writerScope =
    typeof data.writer_scope === "string"
      ? data.writer_scope
      : deriveWriterScope({ ticketId, sourcePath, product, game });
  const landRaw = firstScalar(data, ["land", "land_mode"]);
  const landMode = parseCloseoutMode(typeof landRaw === "string" ? landRaw : undefined);
  return {
    ticketId,
    title,
    status: typeof statusRaw === "string" ? statusRaw : "open",
    dependsOn: firstStringList(data, ["depends_on", "blocked_by", "depends"]),
    planClass: typeof data.plan_class === "string" ? data.plan_class : undefined,
    verifyCommand: yamlVerifyCommand(data.verify) ?? yamlVerifyCommand(data.verify_command),
    provider: typeof data.worker === "string" ? data.worker : undefined,
    model: typeof data.model === "string" ? data.model : undefined,
    ...hold,
    product,
    game,
    writerScope,
    ...(landMode ? { landMode } : {}),
    sourcePath,
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
        humanHold: ticket.humanHold,
        humanHoldReason: ticket.humanHoldReason,
        product: ticket.product,
        game: ticket.game,
        writerScope: ticket.writerScope,
        landMode: ticket.landMode,
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
