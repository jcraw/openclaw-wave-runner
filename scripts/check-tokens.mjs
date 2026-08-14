#!/usr/bin/env node
/**
 * Token / module size gate (DIGEST-007 stand-in).
 * Approximation: ceil(chars / 4). New files and growth past baseline fail.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const baseline = JSON.parse(readFileSync(join(root, "config/token-baseline.json"), "utf8"));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const files = walk(join(root, "src"));
const errors = [];
const warnings = [];
const rows = [];

for (const file of files) {
  const rel = relative(root, file).replaceAll("\\", "/");
  const text = readFileSync(file, "utf8");
  const tokens = Math.ceil(text.length / 4);
  const cap = baseline.allow[rel];
  rows.push({ file: rel, tokens, cap: cap ?? baseline.errorTokens });
  if (cap !== undefined) {
    if (tokens > cap) {
      errors.push(`${rel}: ${tokens} tokens > baseline ${cap}`);
    } else if (tokens > baseline.warnTokens) {
      warnings.push(`${rel}: ${tokens} tokens (baselined ≤ ${cap})`);
    }
    continue;
  }
  if (tokens > baseline.errorTokens) {
    errors.push(`${rel}: ${tokens} tokens > ${baseline.errorTokens} (new/unbaselined)`);
  } else if (tokens > baseline.warnTokens) {
    warnings.push(`${rel}: ${tokens} tokens > warn ${baseline.warnTokens}`);
  }
}

const report = { ok: errors.length === 0, errors, warnings, files: rows };
if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(report)}\n`);
} else {
  for (const w of warnings) console.warn(`token warn: ${w}`);
  if (errors.length) {
    for (const e of errors) console.error(`token fail: ${e}`);
    process.exit(1);
  }
  console.log(`tokens ok (${rows.length} files, ${warnings.length} baselined warnings)`);
}
