#!/usr/bin/env node
/**
 * Fail if any commit uses a GitHub noreply that is not jcraw, or if any
 * author/committer is a personal mailbox. `{login}@users.noreply.github.com`
 * is owned by that GitHub user, not by the display name.
 */
import { execFileSync } from "node:child_process";

const ALLOWED_NOREPLY = new Set(["jcraw", "4335668+jcraw"]);
const ALLOWED_LOCAL = new Set([
  "4335668+jcraw@users.noreply.github.com",
  "jcraw@users.noreply.github.com",
]);
const PERSONAL_MAILBOX = /@gmail\.com$|@googlemail\.com$|@outlook\.com$|@hotmail\.com$|@yahoo\.com$|@icloud\.com$|@me\.com$|@live\.com$/i;
const IN_CI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";

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
const badNoreply = [];
const historyPersonal = [];

for (const email of new Set(history)) {
  const match = email.match(/^([^@]+)@users\.noreply\.github\.com$/i);
  if (match) {
    if (!ALLOWED_NOREPLY.has(match[1].toLowerCase())) badNoreply.push(email);
    continue;
  }
  if (PERSONAL_MAILBOX.test(email)) historyPersonal.push(email);
}

if (badNoreply.length > 0) {
  console.error("git identity: GitHub noreply maps by username, not display name.");
  console.error(`forbidden: ${badNoreply.join(", ")}`);
  console.error("use JCraw <4335668+jcraw@users.noreply.github.com>");
  process.exit(1);
}

if (historyPersonal.length > 0) {
  console.error("git identity: history contains personal-mailbox authors.");
  console.error(`forbidden: ${historyPersonal.join(", ")}`);
  console.error("use JCraw <4335668+jcraw@users.noreply.github.com>");
  process.exit(1);
}

if (!IN_CI) {
  const localBad = [];
  for (const email of configEmail) {
    if (!ALLOWED_LOCAL.has(email.toLowerCase())) localBad.push(email);
  }
  if (localBad.length > 0) {
    console.error("git identity: local user.email must be the jcraw GitHub noreply.");
    console.error(`forbidden local: ${localBad.join(", ")}`);
    console.error("fix: git config user.email 4335668+jcraw@users.noreply.github.com");
    process.exit(1);
  }
}

console.log("git identity ok");
