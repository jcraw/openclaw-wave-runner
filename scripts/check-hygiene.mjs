#!/usr/bin/env node
/**
 * Publish hygiene gates for the public package.
 * Fail closed on host absolutes, secrets-shaped tokens, and private board dumps.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  "tmp",
  "reports",
  ".c8_output",
]);

/** Gitignored verify capture; stdout includes host worktree paths. */
const SKIP_NAMES = new Set(["WAVE_VERIFY.json"]);

const TEXT_EXT = new Set([
  ".ts",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".sh",
  ".yml",
  ".yaml",
  ".toml",
  ".txt",
]);

/** Patterns that must never ship in source/docs. */
const FORBIDDEN = [
  { name: "home-absolute", re: /\/home\/[a-zA-Z0-9._-]+\// },
  { name: "m2-store-path", re: /\/run\/media\/[^\s"']+/ },
  { name: "dropbox-path", re: /\/Dropbox\// },
  { name: "private-key-block", re: /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/ },
  { name: "aws-access-key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "github-pat", re: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { name: "npm-token", re: /\bnpm_[A-Za-z0-9]{20,}\b/ },
  { name: "openai-key", re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: "xai-key", re: /\bxai-[A-Za-z0-9]{20,}\b/ },
];

const ALLOW_FILES = new Set([
  // This checker itself mentions pattern names in comments/strings.
  "scripts/check-hygiene.mjs",
  // Scratch default is the 7.3T data disk; UUID fail-closed lives in these scripts.
  "scripts/drain-eligible.sh",
  "scripts/run-backlog-parallel.sh",
  "scripts/run-backlog-wave.sh",
  "scripts/wave-operator.sh",
  "scripts/cleanup-scratch.sh",
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || SKIP_NAMES.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function isText(path) {
  const lower = path.toLowerCase();
  if (TEXT_EXT.has(lower.slice(lower.lastIndexOf(".")))) return true;
  const base = lower.split("/").pop() ?? "";
  return base === "license" || base === "dockerfile";
}

const files = walk(root).filter(isText);
const hits = [];

for (const file of files) {
  const rel = relative(root, file).replaceAll("\\", "/");
  if (ALLOW_FILES.has(rel)) continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  // Skip binary-ish
  if (text.includes("\u0000")) continue;
  for (const { name, re } of FORBIDDEN) {
    if (re.test(text)) {
      const line = text.split(/\r?\n/).findIndex((l) => re.test(l)) + 1;
      hits.push({ file: rel, rule: name, line });
    }
  }
}

if (hits.length) {
  console.error("hygiene FAILED:");
  for (const h of hits) {
    console.error(`  ${h.file}:${h.line}  [${h.rule}]`);
  }
  process.exit(1);
}

console.log(`hygiene OK (${files.length} text files scanned)`);
