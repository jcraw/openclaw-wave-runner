import { execFileSync } from "node:child_process";

import { resolveLandIdentity, type LandIdentity } from "./land-identity.js";

export const COMMIT_NOISE = [
  "WAVE_VERIFY.json",
  "LAND.json",
  "PROOF.md",
  "VERIFY.json",
  "WORKTREE",
  "tmp",
  "tmp/wave-runs",
];

export function formatGitError(error: unknown, cap = 1000): string {
  const err = error as { message?: string; stderr?: unknown };
  const stderr = typeof err.stderr === "string" ? err.stderr.trim() : "";
  const msg = error instanceof Error ? error.message : String(error);
  const text = stderr && !msg.includes(stderr) ? `${msg}: ${stderr}` : msg;
  return text.length <= cap ? text : `${text.slice(0, cap - 1)}…`;
}

export function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function gitOk(repo: string, args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: git(repo, args) };
  } catch (error) {
    return { ok: false, out: formatGitError(error) };
  }
}

export function readGitConfig(repo: string, key: "user.name" | "user.email"): string {
  const got = gitOk(repo, ["config", "--get", key]);
  return got.ok ? got.out.trim() : "";
}

export function identityArgs(identity: LandIdentity): string[] {
  return ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`];
}

export function commitWithIdentity(
  repo: string,
  identity: LandIdentity,
  message: string,
): { ok: boolean; out: string } {
  return gitOk(repo, [...identityArgs(identity), "commit", "-m", message]);
}

export function resolveRepoIdentity(repoPath: string) {
  return resolveLandIdentity({
    repoPath,
    readConfig: (key) => readGitConfig(repoPath, key),
  });
}

export function commitStagedWorktree(
  worktree: string,
  identity: LandIdentity,
  message: string,
): { ok: true; sha: string } | { ok: false; error: string } {
  git(worktree, ["add", "-A"]);
  for (const path of COMMIT_NOISE) {
    gitOk(worktree, ["reset", "HEAD", "--", path]);
    gitOk(worktree, ["clean", "-fd", "--", path]);
  }
  const staged = gitOk(worktree, ["diff", "--cached", "--name-only"]);
  if (staged.ok && staged.out.trim()) {
    const committed = commitWithIdentity(worktree, identity, message);
    if (!committed.ok) return { ok: false, error: `commit failed: ${committed.out}` };
  }
  return { ok: true, sha: git(worktree, ["rev-parse", "HEAD"]) };
}
