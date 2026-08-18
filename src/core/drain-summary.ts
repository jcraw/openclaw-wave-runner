export type DrainOutcome = "DONE" | "FAILED" | "SKIPPED" | "CLOSEOUT_DEBT";

export type DrainTicketRow = {
  ticketId: string;
  waveId?: string;
  outcome: DrainOutcome;
  reason?: string;
  landOk: boolean;
};

export function outcomeFromTicket(input: {
  ticketId: string;
  status?: string;
  result?: string;
  waveId?: string;
  waveStatus?: string;
}): DrainTicketRow {
  const result = input.result ?? "";
  if (input.status === "DONE") {
    return {
      ticketId: input.ticketId,
      waveId: input.waveId,
      outcome: "DONE",
      reason: result || undefined,
      landOk: true,
    };
  }
  if (result.includes("CLOSEOUT_DEBT:")) {
    return {
      ticketId: input.ticketId,
      waveId: input.waveId,
      outcome: "CLOSEOUT_DEBT",
      reason: result,
      landOk: false,
    };
  }
  return {
    ticketId: input.ticketId,
    waveId: input.waveId,
    outcome: input.status === "CANCELLED" ? "FAILED" : "FAILED",
    reason: result || input.waveStatus || input.status || "failed",
    landOk: false,
  };
}

export function drainExitCode(rows: DrainTicketRow[], bestEffort = false): number {
  if (bestEffort) return 0;
  if (rows.length === 0) return 0;
  return rows.every((row) => row.outcome === "DONE" && row.landOk) ? 0 : 1;
}

export function formatDrainTable(rows: DrainTicketRow[]): string {
  if (rows.length === 0) return "no tickets";
  return rows
    .map((row) => {
      const land = row.landOk ? "land.ok" : "land.miss";
      const reason = row.reason ? ` ${row.reason}` : "";
      return `${row.ticketId} ${row.outcome} ${land}${reason}`;
    })
    .join("\n");
}

/** Per-wave receipt. `tickets` is the truth; never persist only the first row. */
export type WaveResultDoc = {
  waveId?: string;
  tickets: DrainTicketRow[];
};

export function splitTicketIds(raw?: string): string[] {
  return (raw ?? "").split(",").map((id) => id.trim()).filter(Boolean);
}

export function rowsFromWrite(input: {
  ticket: string;
  waveId?: string;
  outcome: DrainOutcome;
  reason?: string;
  landOk: boolean;
}): DrainTicketRow[] {
  const ids = splitTicketIds(input.ticket);
  const names = ids.length ? ids : ["unknown"];
  return names.map((ticketId) => ({
    ticketId,
    waveId: input.waveId,
    outcome: input.outcome,
    reason: input.reason,
    landOk: input.landOk,
  }));
}

export function rowsFromInspect(input: {
  waveId?: string;
  waveStatus?: string;
  tickets?: Array<{ ticketId?: string; status?: string; result?: string }>;
  fallbackTicket?: string;
}): DrainTicketRow[] {
  const listed = (input.tickets ?? []).filter((t) => t.ticketId);
  if (listed.length) {
    return listed.map((t) =>
      outcomeFromTicket({
        ticketId: t.ticketId!,
        status: t.status,
        result: t.result,
        waveId: input.waveId,
        waveStatus: input.waveStatus,
      }),
    );
  }
  return rowsFromWrite({
    ticket: input.fallbackTicket ?? "unknown",
    waveId: input.waveId,
    outcome: "FAILED",
    reason: input.waveStatus ?? "no tickets",
    landOk: false,
  });
}

export function waveResultDoc(rows: DrainTicketRow[], waveId?: string): WaveResultDoc {
  return { ...(waveId ? { waveId } : {}), tickets: rows };
}

export function rowsFromWaveResult(raw: unknown): DrainTicketRow[] {
  if (Array.isArray(raw)) {
    return raw.filter((row): row is DrainTicketRow => Boolean(row && typeof row === "object" && "ticketId" in row));
  }
  if (!raw || typeof raw !== "object") return [];
  const doc = raw as { tickets?: unknown; ticketId?: unknown };
  if (Array.isArray(doc.tickets)) return rowsFromWaveResult(doc.tickets);
  if (typeof doc.ticketId === "string") return [raw as DrainTicketRow];
  return [];
}
