import { WaveError } from "../domain/errors.js";
import { hashJson, sha256 } from "../domain/hash.js";
import type {
  FrozenManifest,
  FrozenTicket,
  SatisfiedExternalDep,
  WaveLimits,
} from "../domain/types.js";

export const TERMINAL_BOARD_STATUSES = new Set(["done", "wontfix", "cancelled", "closed", "complete", "completed"]);

export type TicketCatalogEntry = {
  ticketId: string;
  status: string;
};

export function hashManifest(manifest: FrozenManifest): string {
  return hashJson(manifest);
}

export function hashTicketContent(input: {
  ticketId: string;
  title: string;
  body: string;
  dependsOn: string[];
  sourcePath: string;
}): string {
  return sha256(
    `${input.ticketId}\n${input.title}\n${input.dependsOn.slice().sort().join(",")}\n${input.sourcePath}\n${input.body}`,
  );
}

export function validateManifest(manifest: FrozenManifest): void {
  if (manifest.schema !== 1) {
    throw new WaveError("Unsupported manifest schema.", "bad_manifest");
  }
  if (manifest.drainEverything !== false) {
    throw new WaveError("Manifest must pin drainEverything=false.", "safety_gate");
  }
  if (manifest.overnight !== false || manifest.recurringLlmPolling !== false) {
    throw new WaveError("Manifest must pin overnight and LLM polling off.", "safety_gate");
  }
  if (manifest.deployPush !== false || manifest.productionDrain !== false) {
    throw new WaveError("Manifest must pin deploy/push and production drain off.", "safety_gate");
  }
  if (manifest.supervisedBoundedPilot && manifest.operatorActionRequired !== true) {
    throw new WaveError("Supervised manifests must require operator action.", "safety_gate");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(manifest.waveId)) {
    throw new WaveError("waveId must be 1-64 safe identifier characters.", "bad_manifest");
  }
  if (!manifest.repoPath || !manifest.baseSha) {
    throw new WaveError("Manifest requires repoPath and baseSha.", "bad_manifest");
  }
  if (manifest.tickets.length === 0) {
    throw new WaveError("Manifest requires at least one frozen ticket.", "bad_manifest");
  }
  validateLimits(manifest.limits);
  validateTicketGraph(manifest.tickets);
}

export function validateLimits(limits: WaveLimits): void {
  if (limits.repoConcurrency !== 1) {
    throw new WaveError("v0 repoConcurrency is fixed at 1.", "bad_limits");
  }
  for (const [key, value] of Object.entries(limits)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new WaveError(`Limit ${key} must be a non-negative finite number.`, "bad_limits");
    }
  }
  if (limits.maxLaunches < 1) {
    throw new WaveError("maxLaunches must be at least 1.", "bad_limits");
  }
}

export function normalizeSelectedDependencies(
  selected: FrozenTicket[],
  catalog: TicketCatalogEntry[],
): FrozenTicket[] {
  const selectedIds = new Set(selected.map((ticket) => ticket.ticketId));
  const byId = new Map(catalog.map((entry) => [entry.ticketId, entry]));
  return selected.map((ticket) => {
    const kept: string[] = [];
    const satisfied: SatisfiedExternalDep[] = [...(ticket.satisfiedExternalDeps ?? [])];
    for (const dep of ticket.dependsOn) {
      if (selectedIds.has(dep)) {
        kept.push(dep);
        continue;
      }
      const external = byId.get(dep);
      if (!external) {
        throw new WaveError(`Missing dependency ${dep} for ${ticket.ticketId}.`, "missing_dependency");
      }
      const status = String(external.status ?? "").toLowerCase();
      if (TERMINAL_BOARD_STATUSES.has(status)) {
        if (!satisfied.some((item) => item.ticketId === dep)) {
          satisfied.push({ ticketId: dep, status, reason: "already-done-external" });
        }
        continue;
      }
      throw new WaveError(
        `Open dependency ${dep} (${external.status}) for ${ticket.ticketId} is not selected.`,
        "missing_dependency",
      );
    }
    return {
      ...ticket,
      dependsOn: kept,
      ...(satisfied.length > 0 ? { satisfiedExternalDeps: satisfied } : {}),
    };
  });
}

export function validateTicketGraph(tickets: FrozenTicket[]): void {
  const ids = new Set<string>();
  for (const ticket of tickets) {
    if (!ticket.ticketId || !ticket.contentHash || !ticket.sourcePath) {
      throw new WaveError("Ticket is missing id, content hash, or path.", "bad_ticket");
    }
    if (ids.has(ticket.ticketId)) {
      throw new WaveError(`Duplicate frozen ticket ${ticket.ticketId}.`, "bad_ticket");
    }
    ids.add(ticket.ticketId);
  }
  for (const ticket of tickets) {
    for (const dep of ticket.dependsOn) {
      if (!ids.has(dep)) {
        throw new WaveError(
          `Missing dependency ${dep} for ${ticket.ticketId}.`,
          "missing_dependency",
        );
      }
    }
  }
  if (hasCycle(tickets)) {
    throw new WaveError("Frozen ticket graph contains a cycle.", "dependency_cycle");
  }
}

function hasCycle(tickets: FrozenTicket[]): boolean {
  const byId = new Map(tickets.map((ticket) => [ticket.ticketId, ticket]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (id: string): boolean => {
    if (visited.has(id)) return false;
    if (visiting.has(id)) return true;
    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (walk(dep)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return tickets.some((ticket) => walk(ticket.ticketId));
}

export function topologicalOrder(tickets: FrozenTicket[]): FrozenTicket[] {
  const remaining = new Map(tickets.map((ticket) => [ticket.ticketId, ticket]));
  const done = new Set<string>();
  const ordered: FrozenTicket[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((ticket) => ticket.dependsOn.every((dep) => done.has(dep)))
      .sort((a, b) => a.order - b.order || a.ticketId.localeCompare(b.ticketId));
    if (ready.length === 0) {
      throw new WaveError("Cannot order tickets; cycle or missing dependency.", "dependency_cycle");
    }
    const next = ready[0]!;
    remaining.delete(next.ticketId);
    done.add(next.ticketId);
    ordered.push(next);
  }
  return ordered;
}
