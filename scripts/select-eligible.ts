#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { selectEligibleTickets } from "../src/adapters/eligible-select.js";

function arg(name: string, fallback?: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1]!;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

const repo = resolve(arg("repo"));
const out = resolve(arg("out"));
const skippedPath = process.argv.includes("--skipped")
  ? resolve(arg("skipped"))
  : undefined;
const result = selectEligibleTickets(repo);
writeFileSync(out, result.eligible.join("\n") + (result.eligible.length ? "\n" : ""), "utf8");
if (skippedPath) {
  writeFileSync(
    skippedPath,
    result.skipped.map((row) => JSON.stringify(row)).join("\n") + (result.skipped.length ? "\n" : ""),
    "utf8",
  );
}
for (const row of result.skipped) {
  console.log(`SKIPPED ${row.reason}`);
}
console.log(`eligible_count=${result.eligible.length}`);
for (const tid of result.eligible) console.log(`  ${tid}`);
