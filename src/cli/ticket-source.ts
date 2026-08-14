import { JsonTracker } from "../adapters/json-tracker.js";
import { MarkdownTracker } from "../adapters/markdown-tracker.js";
import type { TrackerAdapter } from "../adapters/ports.js";

export type CliTicketSourceInput = {
  ticketsFlag?: string;
  ticketsJsonFlag?: string;
  repoPath: string;
  jsonText?: string;
};

export type CliTicketSource = {
  tracker: TrackerAdapter;
  ticketIds?: string[];
};

export function splitTicketIds(raw?: string): string[] {
  return (raw ?? "").split(",").map((id) => id.trim()).filter(Boolean);
}

export function resolveCliTicketSource(input: CliTicketSourceInput): CliTicketSource {
  const fromFlag = input.ticketsFlag !== undefined ? splitTicketIds(input.ticketsFlag) : undefined;
  if (input.ticketsJsonFlag !== undefined) {
    const tracker =
      input.ticketsJsonFlag === "-"
        ? JsonTracker.fromJsonText(input.jsonText ?? "")
        : JsonTracker.fromFile(input.ticketsJsonFlag);
    return { tracker, ticketIds: fromFlag ?? tracker.tickets.map((ticket) => ticket.ticketId) };
  }
  return { tracker: new MarkdownTracker(input.repoPath), ticketIds: fromFlag };
}
