#!/usr/bin/env node
/**
 * Shared-ledger / operator-identity helper for supervised wrappers.
 * Bash evals `env` output. Do not duplicate lease rules in shell.
 */
import { canonicalRepoIdentity, operatorIdentityFromWaveId, resolveSupervisedWaveDb } from "../src/core/repo-identity.js";

function arg(name: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1]!;
  throw new Error(`missing --${name}`);
}

function optional(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return undefined;
}

const op = process.argv[2] ?? "env";
const repo = arg("repo");
const wave = optional("wave");
const scratch = optional("scratch");
const explicitDb = optional("db");

if (op !== "env") {
  throw new Error(`unknown wave-ledger op ${op}`);
}

const resolved = resolveSupervisedWaveDb({
  repoPath: repo,
  ...(scratch ? { scratchDir: scratch } : {}),
  ...(explicitDb ? { explicitDb } : {}),
  env: process.env,
  requireScratchUuid: !explicitDb && !process.env.WAVE_DB,
});
const identity = canonicalRepoIdentity(repo);
const operatorId =
  process.env.WAVE_RUNNER_OPERATOR_ID?.trim() ||
  (wave ? operatorIdentityFromWaveId(wave) : undefined);
if (!operatorId) {
  throw new Error("WAVE_RUNNER_OPERATOR_ID or --wave required");
}

process.stdout.write(
  `WAVE_DB=${JSON.stringify(resolved.dbPath)}\nWAVE_RUNNER_OPERATOR_ID=${JSON.stringify(operatorId)}\nCANONICAL_REPO=${JSON.stringify(identity)}\n`,
);
