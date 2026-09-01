import { WaveError } from "../domain/errors.js";
import type { FrozenTicket, StageName } from "../domain/types.js";
import type { AdmitBlocker } from "./admit-overlap.js";

export type PlanWorker = "grok" | "codex";
export type StageAgentId = "grok" | "mona" | "codex";

function asToken(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value.trim().toLowerCase();
  return "";
}

function firstRaw(data: Record<string, unknown> | undefined, keys: string[]): unknown {
  if (!data) return undefined;
  for (const key of keys) {
    if (!(key in data)) continue;
    const value = data[key];
    if (value === undefined || value === null || value === "") continue;
    return value;
  }
  return undefined;
}

function normalizePlanWorker(raw: unknown): PlanWorker | undefined {
  const token = asToken(raw);
  if (token === "grok" || token === "grok-acp") return "grok";
  if (token === "codex" || token === "codex-acp") return "codex";
  return undefined;
}

/** YAML/JSON only. Do not infer from labels, assignee, planClass, or preferred_model. */
export function resolvePlanWorker(data: Record<string, unknown> | undefined): PlanWorker | undefined {
  const raw = firstRaw(data, ["plan_worker", "planWorker"]);
  if (raw !== undefined) return normalizePlanWorker(raw);
  const worker = asToken(firstRaw(data, ["worker", "provider"]));
  return worker === "hybrid" ? "codex" : undefined;
}

export function freezePlanWorker(data: Record<string, unknown> | undefined): { planWorker?: string } {
  if (!data) return {};
  const raw = firstRaw(data, ["plan_worker", "planWorker"]);
  if (raw !== undefined) {
    const resolved = normalizePlanWorker(raw);
    if (resolved) return { planWorker: resolved };
    const keep = typeof raw === "string" ? raw.trim() : asToken(raw);
    return keep ? { planWorker: keep } : {};
  }
  return asToken(firstRaw(data, ["worker", "provider"])) === "hybrid" ? { planWorker: "codex" } : {};
}

export function unknownPlanWorker(planWorker: string | undefined): boolean {
  if (!planWorker?.trim()) return false;
  return normalizePlanWorker(planWorker) === undefined;
}

export function stageAgentId(stage: StageName, ticket: { planWorker?: string }): StageAgentId {
  if (stage === "UX_REVIEW") return "mona";
  if (stage === "PLAN" && ticket.planWorker === "codex") return "codex";
  return "grok";
}

export function planWorkerBlockers(tickets: FrozenTicket[]): AdmitBlocker[] {
  return tickets
    .filter((ticket) => unknownPlanWorker(ticket.planWorker))
    .map((ticket) => ({
      ticketId: ticket.ticketId,
      code: "unknown_plan_worker",
      message: "planWorker is not grok or codex",
    }));
}

/** Dry-run warning only. Drain must still spawn Codex PLAN (WR-041). */
export function codexPlanBlockers(tickets: FrozenTicket[]): AdmitBlocker[] {
  return tickets
    .filter((ticket) => ticket.planWorker === "codex")
    .map((ticket) => ({
      ticketId: ticket.ticketId,
      code: "codex_plan_unsafe",
      message:
        "Codex PLAN: host CLI must support gpt-5.6-sol (codex ≥ 0.152). This is not a Grok fallback.",
    }));
}

export function assertKnownPlanWorkers(tickets: FrozenTicket[]): void {
  const bad = tickets.filter((ticket) => unknownPlanWorker(ticket.planWorker)).map((ticket) => ticket.ticketId);
  if (bad.length) {
    throw new WaveError(`unknown_plan_worker: ${bad.join(", ")}`, "unknown_plan_worker");
  }
}
