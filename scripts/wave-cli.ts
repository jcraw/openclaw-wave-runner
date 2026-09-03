#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { runOperator, type OperatorCommand } from "../src/cli/operations.js";
import { resolveCliTicketSource } from "../src/cli/ticket-source.js";
import { DEFAULT_LIMITS, SUPERVISED_PILOT_LIMITS } from "../src/domain/types.js";
import { SafetyGateError } from "../src/domain/errors.js";
import { DatabaseSync } from "node:sqlite";

import { countLiveForAdmitPath, parseAcpSlotsMax } from "../src/core/acp-slots.js";
import { resolveCliOperatorIdentity, resolveSupervisedWaveDb } from "../src/core/repo-identity.js";
import { collectLiveStatus } from "../src/core/run-status.js";
import { cliControllerAcpFields, openCliController } from "../src/runtime.js";

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

const op = process.argv[2] ?? "capabilities";
const repoPath = optional("repo") ?? process.cwd();
const supervised = process.argv.includes("--supervised");
const waveIdFlag = optional("wave");
if (op === "resolve-ledger") {
  const resolved = resolveSupervisedWaveDb({ repoPath, env: process.env });
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(resolved)}\n`);
  } else {
    process.stdout.write(`${resolved.dbPath}\n`);
  }
  process.exit(0);
}
if (op === "list-live") {
  const dbFile = optional("db");
  if (!dbFile) throw new Error("missing --db");
  const dead = new Set(["COMPLETED", "FAILED", "CANCELLED", "BUDGET_STOPPED", "BLOCKED"]);
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const rows = db.prepare("SELECT repo_path, status FROM waves").all() as Array<{
    repo_path?: string;
    status?: string;
  }>;
  const live = rows.find((r) => !dead.has(String(r.status)));
  if (live?.repo_path) process.stdout.write(String(live.repo_path));
  process.exit(0);
}
if (op === "status") {
  const scratch = process.env.WR_SCRATCH?.trim();
  if (!scratch) throw new Error("status requires WR_SCRATCH");
  const report = collectLiveStatus(scratch);
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (!report.alive) {
    process.stdout.write("SUPERVISOR_DEAD\n");
    for (const t of report.tickets) {
      process.stdout.write(`${t.waveId} ${t.ticketId} ${t.stage} ${t.status} ${t.nextAction}\n`);
    }
  } else {
    const age = report.heartbeat ? Math.round(Date.now() / 1000 - report.heartbeat.ts) : -1;
    process.stdout.write(`SUPERVISOR_OK pid=${report.heartbeat?.pid ?? "?"} heartbeat_s=${age} err=${report.heartbeat?.lastError || ""}\n`);
    for (const t of report.tickets) {
      process.stdout.write(`${t.waveId} ${t.ticketId} ${t.stage} ${t.status} ${t.nextAction}\n`);
    }
  }
  process.exit(report.alive ? 0 : 1);
}
const explicitDb = optional("db");
const dbPath = resolve(
  explicitDb ??
    (supervised && (process.env.WAVE_DB || process.env.WR_SCRATCH)
      ? resolveSupervisedWaveDb({ repoPath, env: process.env }).dbPath
      : `${process.cwd()}/tmp/wave-runner/wave.sqlite`),
);
if (supervised) {
  resolveCliOperatorIdentity({ supervised: true, waveId: waveIdFlag, env: process.env });
}
const simulate = process.argv.includes("--simulate");
const disableAcp =
  process.argv.includes("--no-acp") || process.argv.includes("--disable-acp");
// Supervised bounded launch is the intentional real-worker path (restored 2026-08-15).
// Unrestricted drain / unprompted re-drain remain disabled inside SAFETY + assertSupervisedBoundedLaunch.
if ((op === "start" || op === "tick" || op === "tick-all" || op === "enqueue") && !supervised && !simulate) {
  throw new SafetyGateError(
    "CLI start/tick/enqueue require --supervised (real worker) or --simulate (mock only).",
  );
}
const ticketsJsonFlag = optional("tickets-json");
const jsonText = ticketsJsonFlag === "-" ? readFileSync(0, "utf8") : undefined;
const ticketSource = resolveCliTicketSource({
  ticketsFlag: optional("tickets"),
  ticketsJsonFlag,
  repoPath,
  jsonText,
});
const ledgerDir = process.env.WR_SCRATCH ? `${process.env.WR_SCRATCH.replace(/\/$/, "")}/ledgers` : undefined;
const controller = openCliController({
  dbPath,
  repoPath,
  supervised,
  ...(waveIdFlag ? { waveId: waveIdFlag } : {}),
  worktreeRoot: optional("worktree-root"),
  artifactRoot: optional("artifact-root"),
  launcherPath: optional("launcher"),
  ticketSourcePath: optional("ticket-md"),
  tracker: ticketSource.tracker,
  ...cliControllerAcpFields({
    supervised,
    disableAcp,
    gatewayUrl: optional("gateway-url"),
    gatewayToken: optional("gateway-token"),
    acpSessionKey: optional("acp-session-key"),
    acpAgentId: optional("acp-agent-id"),
  }),
});
controller.acpSlotsMax = parseAcpSlotsMax(process.env.WAVE_ACP_SLOTS);
if (ledgerDir) {
  controller.countLiveProvider = (provider) => countLiveForAdmitPath(dbPath, ledgerDir, provider);
}

function positiveInt(name: string, fallback: number): number {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  return value;
}

/** Allow 0 for no-deadline wall clocks (max-wall-ms). */
function nonNegativeInt(name: string, fallback: number): number {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`--${name} must be a non-negative integer`);
  return value;
}

const command: OperatorCommand = (() => {
  switch (op) {
    case "dry-run":
    case "create":
      const ticketIds =
        ticketSource.ticketIds ?? arg("tickets").split(",").map((id) => id.trim()).filter(Boolean);
      return {
        op,
        input: {
          waveId: arg("wave"),
          repoPath,
          ticketIds,
          limits: supervised
            ? {
                ...SUPERVISED_PILOT_LIMITS,
                maxTokens: positiveInt("max-tokens", SUPERVISED_PILOT_LIMITS.maxTokens),
                maxLaunches: positiveInt("max-launches", SUPERVISED_PILOT_LIMITS.maxLaunches),
                maxWallTimeMs: nonNegativeInt("max-wall-ms", SUPERVISED_PILOT_LIMITS.maxWallTimeMs),
              }
            : DEFAULT_LIMITS,
          supervisedBoundedPilot: supervised,
          isolatedWorktreeRoot: optional("worktree-root"),
          operatorAction: supervised,
        },
      };
    case "start":
      return { op, waveId: arg("wave"), supervised };
    case "freeze":
    case "inspect":
    case "pause":
    case "resume":
    case "cancel":
      return { op, waveId: arg("wave") };
    case "tick":
      return { op, waveId: arg("wave"), supervised };
    case "approve":
      return {
        op,
        waveId: arg("wave"),
        ticketId: arg("ticket"),
        expectedRevision: Number(arg("revision")),
      };
    case "project":
      return { op, outPath: optional("out") };
    case "emergency-stop":
      return { op, reason: optional("reason") };
    case "backup":
      return { op, destPath: arg("dest") };
    case "land-retry":
      return { op, waveId: arg("wave"), ticketId: arg("ticket") };
    case "enqueue": {
      const ticketIds =
        ticketSource.ticketIds ?? arg("tickets").split(",").map((id) => id.trim()).filter(Boolean);
      return {
        op,
        input: {
          waveId: waveIdFlag ?? arg("wave"),
          repoPath,
          ticketIds,
          limits: supervised
            ? {
                ...SUPERVISED_PILOT_LIMITS,
                maxTokens: positiveInt("max-tokens", SUPERVISED_PILOT_LIMITS.maxTokens),
                maxLaunches: positiveInt("max-launches", SUPERVISED_PILOT_LIMITS.maxLaunches),
                maxWallTimeMs: nonNegativeInt("max-wall-ms", SUPERVISED_PILOT_LIMITS.maxWallTimeMs),
              }
            : DEFAULT_LIMITS,
          supervisedBoundedPilot: supervised,
          isolatedWorktreeRoot: optional("worktree-root"),
          operatorAction: supervised,
        },
      };
    }
    case "tick-all":
      return { op, supervised };
    default:
      return { op: "capabilities" };
  }
})();

const result = await runOperator(controller, command);
console.log(JSON.stringify(result, null, 2));
