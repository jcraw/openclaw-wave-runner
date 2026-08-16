import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { LandResult, WorkspaceAdapter } from "./ports.js";
import { resolveLandIdentity, type LandIdentity } from "./land-identity.js";
import {
  commitStagedWorktree,
  commitWithIdentity,
  formatGitError,
  git,
  gitOk,
  identityArgs,
  readGitConfig,
} from "./worktree-commit.js";

export { formatGitError, git, gitOk };

type LandToMainInput = NonNullable<Parameters<NonNullable<WorkspaceAdapter["landToMain"]>>[0]>;

const landTails = new Map<string, Promise<void>>();

export function enqueueLand<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = landTails.get(repoPath) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  landTails.set(repoPath, run.then(() => undefined, () => undefined));
  return run;
}

function durableProofPath(input: LandToMainInput): string {
  return join(input.artifactRoot ?? input.repoPath, "tmp", "wave-runner", input.waveId, input.ticketId, "LAND.json");
}

function writeLandProof(durable: string, worktree: string, result: LandResult, extra?: Record<string, unknown>): void {
  const body = `${JSON.stringify({ ...result, ...extra }, null, 2)}\n`;
  mkdirSync(dirname(durable), { recursive: true });
  writeFileSync(durable, body, "utf8");
  try {
    writeFileSync(join(worktree, "LAND.json"), body, "utf8");
  } catch { /* convenience */ }
}

function listedPaths(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

function dirtyPaths(repo: string): string[] {
  const names = new Set<string>();
  for (const args of [["diff", "--name-only"], ["diff", "--name-only", "--cached"], ["ls-files", "--others", "--exclude-standard"]]) {
    const got = gitOk(repo, args);
    if (got.ok) for (const p of listedPaths(got.out)) names.add(p);
  }
  return [...names];
}

function incomingPaths(repo: string, from: string, to: string): string[] {
  const got = gitOk(repo, ["diff", "--name-only", from, to]);
  return got.ok ? listedPaths(got.out) : [];
}

function mainBranch(repo: string): string {
  const branches = gitOk(repo, ["branch", "--list", "main", "master"]).out;
  if (branches.includes("main")) return "main";
  if (branches.includes("master")) return "master";
  return "main";
}

function isAncestor(repo: string, tip: string, head: string): boolean {
  return gitOk(repo, ["merge-base", "--is-ancestor", tip, head]).ok;
}

function removeImplWorktree(repo: string, worktree: string): void {
  if (!gitOk(repo, ["worktree", "remove", "--force", worktree]).ok) return;
  if (!existsSync(worktree)) return;
  try {
    rmSync(worktree, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function markBoardDone(repo: string, ticketId: string): string[] {
  const board = join(repo, "issues", "BOARD.md");
  if (!existsSync(board)) return [];
  const text = readFileSync(board, "utf8");
  const re = new RegExp(`(-\\s\\*\\*${ticketId}\\s+)open(\\*\\*)`, "g");
  const next = text.replace(re, `$1done$2`);
  if (next === text) return [];
  writeFileSync(board, next, "utf8");
  return ["issues/BOARD.md"];
}

function markIssueDone(repo: string, ticketId: string): string[] {
  const dir = join(repo, "issues");
  if (!existsSync(dir)) return [];
  const changed: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(ticketId) || !name.endsWith(".md")) continue;
    const path = join(dir, name);
    const text = readFileSync(path, "utf8");
    const next = text.replace(/^---\r?\n[\s\S]*?\r?\n---/, (fm) => {
      if (/^status:\s*/m.test(fm)) return fm.replace(/^status:\s*.*$/m, "status: done");
      return fm.replace(/^---\r?\n/, "---\nstatus: done\n");
    });
    if (next !== text) {
      writeFileSync(path, next, "utf8");
      changed.push(`issues/${name}`);
    }
  }
  return changed;
}

function closeoutBoard(repo: string, ticketId: string, identity: LandIdentity): { ok: boolean; error?: string } {
  try {
    const paths = [...markBoardDone(repo, ticketId), ...markIssueDone(repo, ticketId)];
    if (paths.length === 0) return { ok: true };
    const add = gitOk(repo, ["add", "--", ...paths]);
    if (!add.ok) return { ok: false, error: add.out };
    const staged = gitOk(repo, ["diff", "--cached", "--name-only"]);
    if (!staged.ok || !staged.out.trim()) return { ok: true };
    const committed = commitWithIdentity(repo, identity, `Board: mark ${ticketId} done after land.`);
    if (!committed.ok) return { ok: false, error: committed.out };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: formatGitError(error) };
  }
}

export async function executeLandToMain(input: LandToMainInput): Promise<LandResult> {
  const proof = durableProofPath(input);
  const fail = (error: string, extra: Record<string, unknown> = {}): LandResult => {
    const result: LandResult = {
      ok: false,
      proof,
      error,
      ...(typeof extra.commitSha === "string" ? { commitSha: extra.commitSha } : {}),
    };
    writeLandProof(proof, input.worktree, result, extra);
    return result;
  };
  const finishOk = (commitSha: string, extra: Record<string, unknown> = {}): LandResult => {
    const result: LandResult = { ok: true, commitSha, proof };
    writeLandProof(proof, input.worktree, result, extra);
    removeImplWorktree(input.repoPath, input.worktree);
    return result;
  };

  try {
    const resolved = resolveLandIdentity({
      repoPath: input.repoPath,
      readConfig: (key) => readGitConfig(input.repoPath, key),
    });
    if (!resolved.ok) return fail(resolved.error);
    const identity = resolved.identity;

    const committed = commitStagedWorktree(
      input.worktree,
      identity,
      `Land ${input.ticketId} (${input.waveId}).`,
    );
    if (!committed.ok) return fail(committed.error);
    const tip = committed.sha;
    const main = mainBranch(input.repoPath);
    const onMain = gitOk(input.repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]).out === main;
    const dirty = git(input.repoPath, ["status", "--porcelain"]).length > 0;
    if (!onMain) {
      if (dirty) return fail("primary not on main and dirty");
      const checkout = gitOk(input.repoPath, ["checkout", main]);
      if (!checkout.ok) return fail(`checkout ${main} failed: ${checkout.out}`);
    }

    const primaryHead = git(input.repoPath, ["rev-parse", "HEAD"]);
    const alreadyOnPrimary = tip === primaryHead;
    const skipMerge = alreadyOnPrimary || isAncestor(input.repoPath, tip, primaryHead);
    if (!skipMerge) {
      if (dirty) {
        const overlap = incomingPaths(input.repoPath, primaryHead, tip).filter((p) =>
          dirtyPaths(input.repoPath).includes(p),
        );
        if (overlap.length) return fail(`primary dirty overlaps land: ${overlap.join(", ")}`);
      }
      let merge = gitOk(input.repoPath, ["merge", "--ff-only", tip]);
      if (!merge.ok) {
        const branch =
          input.branch ||
          gitOk(input.worktree, ["rev-parse", "--abbrev-ref", "HEAD"]).out ||
          `wave/${input.waveId}/${input.ticketId}`;
        merge = gitOk(input.repoPath, [
          ...identityArgs(identity),
          "merge",
          "--no-ff",
          "-m",
          `Merge ${input.ticketId} from ${branch}`,
          tip,
        ]);
      }
      if (!merge.ok) return fail(`merge failed: ${merge.out}`);
    }

    let commitSha = git(input.repoPath, ["rev-parse", "HEAD"]);
    if (input.push) {
      const pushed = gitOk(input.repoPath, ["push", "origin", main]);
      if (!pushed.ok) return fail(`push failed: ${pushed.out}`, { commitSha });
    }

    if (!alreadyOnPrimary) {
      const board = closeoutBoard(input.repoPath, input.ticketId, identity);
      if (!board.ok) {
        commitSha = gitOk(input.repoPath, ["rev-parse", "HEAD"]).out || commitSha;
        return fail(`board closeout failed: ${board.error ?? "unknown"}`, { commitSha, boardOk: false });
      }
    }
    commitSha = git(input.repoPath, ["rev-parse", "HEAD"]);
    return finishOk(commitSha, alreadyOnPrimary ? { note: "already-on-primary" } : {});
  } catch (error) {
    return fail(formatGitError(error));
  }
}
