#!/usr/bin/env node
/**
 * Compact DoD JSON for agents (DIGEST-007/025). Keep this file's stdout small.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function run(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: root, encoding: "utf8" });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function parseJsonFlag(script) {
  const result = run(process.execPath, [join(root, "scripts", script), "--json"]);
  try {
    return { code: result.code, data: JSON.parse(result.stdout || "{}") };
  } catch {
    return { code: result.code, data: { ok: false, parseError: true } };
  }
}

const typecheck = run("npx", ["tsc", "-p", "tsconfig.json", "--noEmit"]);
const hygiene = run(process.execPath, [join(root, "scripts/check-hygiene.mjs")]);
const tokens = parseJsonFlag("check-tokens.mjs");
const arch = parseJsonFlag("check-architecture.mjs");

const summary = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  typecheck: typecheck.code,
  hygiene: hygiene.code,
  architecture: arch.code,
  token_new_errors: (tokens.data.errors ?? []).length,
  token_warnings: (tokens.data.warnings ?? []).length,
  tests_fail: null,
  mutation: null,
  notes: [
    "Run npm test / npm run mutation separately; this emitter stays token-cheap.",
    "Do not treat coverage % as DoD.",
  ],
  token_errors: tokens.data.errors ?? [],
  arch_errors: arch.data.errors ?? [],
};

const ok =
  summary.typecheck === 0 &&
  summary.hygiene === 0 &&
  summary.architecture === 0 &&
  summary.token_new_errors === 0;

summary.ok = ok;

const outDir = join(root, "tmp");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "dod-summary.json");
writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ok, path: "tmp/dod-summary.json", typecheck: summary.typecheck, hygiene: summary.hygiene, architecture: summary.architecture, token_new_errors: summary.token_new_errors })}\n`);
if (!ok) process.exit(1);
