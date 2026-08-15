import { readFileSync } from "node:fs";

import { resolveHumanHold } from "../core/human-hold.js";
import { hashTicketContent, normalizeSelectedDependencies } from "../core/manifest.js";
import type { FrozenTicket, TicketSelector } from "../domain/types.js";
import type { TicketProjection, TrackerAdapter } from "./ports.js";

export type JsonTicketIngest = {
  ticketId: string;
  title: string;
  dependsOn: string[];
  sourcePath: string;
  status: string;
  body: string;
  verifyCommand?: string;
  planClass?: string;
  provider?: string;
  model?: string;
  needsJason?: boolean | string;
  eligibility?: string;
  humanHold?: boolean;
  humanHoldReason?: "needs_jason" | "human_gated";
};

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`JSON ticket missing ${field}`);
  }
  return value;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function parseJsonTickets(text: string): JsonTicketIngest[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON ticket source");
  }
  let rows: unknown[];
  if (Array.isArray(parsed)) {
    rows = parsed;
  } else {
    const obj = asObject(parsed);
    if (!obj) throw new Error("JSON ticket source must be an array or schema 1 object");
    if (obj.schema !== 1) throw new Error("Unsupported JSON ticket schema");
    if (!Array.isArray(obj.tickets)) throw new Error("JSON ticket source missing tickets array");
    rows = obj.tickets;
  }
  const seen = new Set<string>();
  return rows.map((row, index) => {
    const obj = asObject(row);
    if (!obj) throw new Error(`JSON ticket ${index} is not an object`);
    const ticketId = requireText(obj.ticketId, "ticketId");
    const sourcePath = requireText(obj.sourcePath, "sourcePath");
    if (seen.has(ticketId)) throw new Error(`Duplicate ticketId ${ticketId}`);
    seen.add(ticketId);
    if (obj.dependsOn !== undefined) {
      if (!Array.isArray(obj.dependsOn) || obj.dependsOn.some((dep) => typeof dep !== "string")) {
        throw new Error(`JSON ticket ${ticketId} dependsOn must be a string array`);
      }
    }
    const hold = resolveHumanHold({
      needsJason: obj.needs_jason ?? obj.needsJason,
      eligibility: obj.eligibility,
    });
    return {
      ticketId,
      title: optionalText(obj.title) ?? ticketId,
      dependsOn: Array.isArray(obj.dependsOn) ? (obj.dependsOn as string[]) : [],
      sourcePath,
      status: optionalText(obj.status) ?? "open",
      body: typeof obj.body === "string" ? obj.body : "",
      verifyCommand: optionalText(obj.verifyCommand),
      planClass: optionalText(obj.planClass),
      provider: optionalText(obj.provider),
      model: optionalText(obj.model),
      ...hold,
    };
  });
}

export class JsonTracker implements TrackerAdapter {
  constructor(readonly tickets: readonly JsonTicketIngest[]) {}

  static fromJsonText(text: string): JsonTracker {
    return new JsonTracker(parseJsonTickets(text));
  }

  static fromFile(path: string): JsonTracker {
    return JsonTracker.fromJsonText(readFileSync(path, "utf8"));
  }

  async snapshot(selection: TicketSelector): Promise<FrozenTicket[]> {
    const byId = new Map(this.tickets.map((ticket) => [ticket.ticketId, ticket]));
    const selected = selection.ticketIds.map((id, index) => {
      const ticket = byId.get(id);
      if (!ticket) throw new Error(`Ticket ${id} not found`);
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
      };
    });
    return normalizeSelectedDependencies(
      selected,
      this.tickets.map((ticket) => ({ ticketId: ticket.ticketId, status: ticket.status })),
    );
  }

  async mirror(_update: TicketProjection): Promise<void> {}
}
