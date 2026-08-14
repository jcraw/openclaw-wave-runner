#!/usr/bin/env node
/**
 * Fail if any commit (or local user.email) uses a GitHub noreply that is not jcraw.
 * `{login}@users.noreply.github.com` is owned by that GitHub user, not by the display name.
 */
import { execFileSync } from "node:child_process";

const ALLOWED_NOREPLY = new Set(["jcraw", "4335668+jcraw"]);

function gitLines(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8" })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

const history = gitLines(["log", "--format=%ae%n%ce"]);
const configEmail = gitLines(["config", "--get", "user.email"]);
const bad = [];

for (const email of new Set([...history, ...configEmail])) {
  const match = email.match(/^([^@]+)@users\.noreply\.github\.com$/i);
  if (!match) continue;
  if (!ALLOWED_NOREPLY.has(match[1].toLowerCase())) bad.push(email);
}

if (bad.length > 0) {
  console.error("git identity: GitHub noreply maps by username, not display name.");
  console.error(`forbidden: ${bad.join(", ")}`);
  console.error("use JCraw <4335668+jcraw@users.noreply.github.com> or 4335668+jcraw@users.noreply.github.com");
  process.exit(1);
}

console.log("git identity ok");
