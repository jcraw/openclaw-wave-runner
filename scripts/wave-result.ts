#!/usr/bin/env node
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  drainExitCode,
  formatDrainTable,
  rowsFromInspect,
  rowsFromWaveResult,
  rowsFromWrite,
  waveResultDoc,
  type DrainOutcome,
  type DrainTicketRow,
} from "../src/core/drain-summary.js";

function arg(name: string, fallback?: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1]!;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

function optional(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return undefined;
}

const op = process.argv[2] ?? "help";

function writeWaveResult(out: string, rows: DrainTicketRow[], waveId?: string, lane?: string) {
  const doc = waveResultDoc(rows, waveId);
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  if (lane) {
    for (const row of rows) appendFileSync(resolve(lane), `${JSON.stringify(row)}\n`, "utf8");
  }
}

if (op === "write") {
  const waveId = optional("wave");
  const rows = rowsFromWrite({
    ticket: arg("ticket"),
    waveId,
    outcome: arg("outcome") as DrainOutcome,
    reason: optional("reason"),
    landOk: arg("land-ok", "0") === "1",
  });
  writeWaveResult(resolve(arg("out")), rows, waveId, optional("lane-summary"));
  process.exit(0);
}

if (op === "from-inspect") {
  const inspectPath = resolve(arg("inspect"));
  const raw = JSON.parse(readFileSync(inspectPath, "utf8")) as {
    wave?: { status?: string; waveId?: string };
    tickets?: Array<{ ticketId: string; status: string; result?: string }>;
  };
  const waveId = raw.wave?.waveId ?? optional("wave");
  const rows = rowsFromInspect({
    waveId,
    waveStatus: raw.wave?.status,
    tickets: raw.tickets,
    fallbackTicket: optional("ticket"),
  });
  writeWaveResult(resolve(arg("out")), rows, waveId, optional("lane-summary"));
  process.exit(0);
}

if (op === "rollup") {
  const root = resolve(arg("root"));
  const rows: DrainTicketRow[] = [];
  const walk = (dir: string) => {
    let names: import("node:fs").Dirent[] = [];
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of names) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(p);
      } else if (ent.name === "WAVE_RESULT.json") {
        try {
          rows.push(...rowsFromWaveResult(JSON.parse(readFileSync(p, "utf8"))));
        } catch {
          /* skip */
        }
      }
    }
  };
  walk(root);
  const table = formatDrainTable(rows);
  console.log(table || "no WAVE_RESULT.json");
  writeFileSync(join(root, "DRAIN_SUMMARY.txt"), `${table}\n`, "utf8");
  writeFileSync(join(root, "DRAIN_SUMMARY.json"), `${JSON.stringify(rows, null, 2)}\n`, "utf8");
  const best = process.env.WAVE_DRAIN_BEST_EFFORT === "1";
  process.exit(drainExitCode(rows, best));
}

console.log("usage: wave-result write|from-inspect|rollup");
process.exit(2);
