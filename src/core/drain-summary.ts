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
