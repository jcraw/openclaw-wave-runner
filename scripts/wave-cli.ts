#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { runOperator, type OperatorCommand } from "../src/cli/operations.js";
import { resolveCliTicketSource } from "../src/cli/ticket-source.js";
import { DEFAULT_LIMITS, SUPERVISED_PILOT_LIMITS } from "../src/domain/types.js";
import { SafetyGateError } from "../src/domain/errors.js";
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
const dbPath = resolve(arg("db", `${process.cwd()}/tmp/wave-runner/wave.sqlite`));
const repoPath = optional("repo") ?? process.cwd();
const supervised = process.argv.includes("--supervised");
const simulate = process.argv.includes("--simulate");
const disableAcp =
  process.argv.includes("--no-acp") || process.argv.includes("--disable-acp");
if ((op === "start" || op === "tick") && !supervised && !simulate) {
  throw new SafetyGateError(
    "CLI start/tick require --supervised (real singleton worker) or --simulate (mock only).",
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
const controller = openCliController({
  dbPath,
  repoPath,
  supervised,
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

function positiveInt(name: string, fallback: number): number {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
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
                maxLaunches: positiveInt("max-launches", Math.min(6, ticketIds.length * 2)),
                maxWallTimeMs: positiveInt("max-wall-ms", SUPERVISED_PILOT_LIMITS.maxWallTimeMs),
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
    default:
      return { op: "capabilities" };
  }
})();

const result = await runOperator(controller, command);
console.log(JSON.stringify(result, null, 2));
