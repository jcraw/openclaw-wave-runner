#!/usr/bin/env node
/**
 * Import-slice gate (DIGEST-025 Konsist stand-in).
 * Pure core/domain/store must not import adapters, CLI, or runtime entrypoints.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcRoot = join(root, "src");

const FORBIDDEN = {
  "src/domain": [/\/adapters\//, /\/cli\//, /\/runtime\.js/, /\/index\.js/, /\/controller\.js/],
  "src/core": [/\/adapters\//, /\/cli\//, /\/runtime\.js/, /\/index\.js/],
  "src/store": [/\/adapters\//, /\/cli\//, /\/runtime\.js/, /\/index\.js/, /\/controller\.js/],
};

/** Composition-root leak removed in WR-001: ports and stage paths live in core. */
const ALLOW = new Set();


function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const importRe = /from\s+["']([^"']+)["']/g;
const errors = [];

for (const [slice, patterns] of Object.entries(FORBIDDEN)) {
  const dir = join(root, slice);
  for (const file of walk(dir)) {
    const rel = relative(root, file).replaceAll("\\", "/");
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(importRe)) {
      const spec = match[1];
      if (!spec.startsWith(".")) continue;
      const resolved = join(dirname(file), spec).replaceAll("\\", "/");
      const fromSrc = relative(srcRoot, resolved).replaceAll("\\", "/");
      const normalized = `src/${fromSrc}`;
      const dest = normalized.replace(/\.(js|ts)$/, "");
      const allowKey = `${rel} -> ${dest}`;
      if (ALLOW.has(allowKey)) continue;
      if (patterns.some((re) => re.test(normalized) || re.test(dest))) {
        errors.push(`${rel} imports ${spec} → ${normalized}`);
      }
    }
  }
}

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify({ ok: errors.length === 0, errors })}\n`);
} else if (errors.length) {
  for (const e of errors) console.error(`arch fail: ${e}`);
  process.exit(1);
} else {
  console.log("architecture ok (core/domain/store isolated from adapters)");
}
