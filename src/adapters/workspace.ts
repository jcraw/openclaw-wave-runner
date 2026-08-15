import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { WaveError } from "../domain/errors.js";
import type { LandResult, WorkspaceAdapter, WorktreeSpec } from "./ports.js";

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitOk(repo: string, args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: git(repo, args) };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, out: msg };
  }
}

export class GitWorkspace implements WorkspaceAdapter {
  async currentHead(repoPath: string): Promise<string> {
    return git(repoPath, ["rev-parse", "HEAD"]);
  }

  async createImplWorktree(spec: WorktreeSpec): Promise<{ worktree: string; branch: string }> {
    const worktree = join(spec.worktreeRoot, spec.waveId, spec.ticketId);
    const branch = `wave/${spec.waveId}/${spec.ticketId}`;
    mkdirSync(join(spec.worktreeRoot, spec.waveId), { recursive: true });
    if (!existsSync(worktree)) {
      git(spec.repoPath, ["worktree", "add", "-B", branch, worktree, spec.baseSha]);
    }
    return { worktree, branch };
  }

  async writePlanArtifact(input: {
    repoPath: string;
    waveId: string;
    ticketId: string;
    contents: string;
    artifactRoot?: string;
  }): Promise<string> {
    const dir = join(
      input.artifactRoot ?? input.repoPath,
      "tmp",
      "wave-runner",
      input.waveId,
      input.ticketId,
    );
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "PLAN.md");
    writeFileSync(path, input.contents, "utf8");
    return path;
  }

  async verify(input: { worktree: string; command: string }): Promise<{ ok: boolean; proof: string }> {
    const proof = join(input.worktree, "WAVE_VERIFY.json");
    let ok = true;
    let output = "";
    try {
      output = execFileSync("bash", ["-lc", input.command], {
        cwd: input.worktree,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      ok = false;
      output = error instanceof Error ? error.message : String(error);
    }
    writeFileSync(proof, JSON.stringify({ ok, command: input.command, output }, null, 2), "utf8");
    return { ok, proof };
  }

  async recordProof(input: { worktree: string; ticketId: string; proof: string }): Promise<string> {
    const path = join(input.worktree, "PROOF.md");
    writeFileSync(path, `# ${input.ticketId}\n\n${input.proof}\n`, "utf8");
    return path;
  }

  async primaryDirty(repoPath: string): Promise<boolean> {
    const status = git(repoPath, ["status", "--porcelain"]);
    return status.length > 0;
  }

  /**
   * WR-013 land-on-done: commit worktree changes onto primary main.
   * Strategy: commit in worktree if dirty, then merge --ff-only (or --no-ff) into main.
   * Push only when input.push === true (wave-runner OSS standing).
   */
  async landToMain(input: {
    repoPath: string;
    worktree: string;
    branch?: string;
    ticketId: string;
    waveId: string;
    baseSha: string;
    push?: boolean;
  }): Promise<LandResult> {
    const proof = join(input.worktree, "LAND.json");
    try {
      const branch =
        input.branch ||
        git(input.worktree, ["rev-parse", "--abbrev-ref", "HEAD"]) ||
        `wave/${input.waveId}/${input.ticketId}`;

      // Stage product changes in worktree (exclude wave runtime noise).
      git(input.worktree, ["add", "-A"]);
      for (const path of ["WAVE_VERIFY.json", "LAND.json", "PROOF.md", "VERIFY.json", "WORKTREE"]) {
        gitOk(input.worktree, ["reset", "HEAD", "--", path]);
        // Keep runtime noise out of the index and tree.
        gitOk(input.worktree, ["clean", "-f", "--", path]);
      }
      const staged = gitOk(input.worktree, ["diff", "--cached", "--name-only"]);
      if (staged.ok && staged.out.trim().length > 0) {
        const committed = gitOk(input.worktree, [
          "-c",
          "user.email=wave-runner@local",
          "-c",
          "user.name=Wave Runner",
          "commit",
          "-m",
          `Land ${input.ticketId} (${input.waveId}).`,
        ]);
        if (!committed.ok) {
          const result: LandResult = { ok: false, proof, error: `commit failed: ${committed.out}` };
          writeFileSync(proof, JSON.stringify(result, null, 2), "utf8");
          return result;
        }
      }
      const tip = git(input.worktree, ["rev-parse", "HEAD"]);
      const primaryHead = git(input.repoPath, ["rev-parse", "HEAD"]);
      if (tip === primaryHead) {
        const result: LandResult = { ok: true, commitSha: tip, proof };
        writeFileSync(proof, JSON.stringify({ ...result, note: "already-on-primary" }, null, 2), "utf8");
        return result;
      }

      // Ensure primary is on main (or master).
      const branches = git(input.repoPath, ["branch", "--list", "main", "master"]);
      const mainName = branches.includes("main")
        ? "main"
        : branches.includes("master")
          ? "master"
          : "main";
      gitOk(input.repoPath, ["checkout", mainName]);

      // Board mirror may dirty primary before land; stash then restore.
      const primaryDirtyBefore = git(input.repoPath, ["status", "--porcelain"]);
      let stashed = false;
      if (primaryDirtyBefore.length > 0) {
        gitOk(input.repoPath, ["add", "-A"]);
        const st = gitOk(input.repoPath, [
          "stash",
          "push",
          "-u",
          "-m",
          "wave-runner-land-temp",
        ]);
        stashed = st.ok;
      }

      // Prefer fast-forward; fall back to no-ff merge of the wave branch.
      let merge = gitOk(input.repoPath, ["merge", "--ff-only", tip]);
      if (!merge.ok) {
        merge = gitOk(input.repoPath, [
          "merge",
          "--no-ff",
          "-m",
          `Merge ${input.ticketId} from ${branch}`,
          tip,
        ]);
      }
      if (!merge.ok) {
        if (stashed) gitOk(input.repoPath, ["stash", "pop"]);
        const result: LandResult = {
          ok: false,
          proof,
          error: `merge failed: ${merge.out}`,
        };
        writeFileSync(proof, JSON.stringify(result, null, 2), "utf8");
        return result;
      }

      if (stashed) gitOk(input.repoPath, ["stash", "pop"]);

      const commitSha = git(input.repoPath, ["rev-parse", "HEAD"]);
      if (input.push) {
        const push = gitOk(input.repoPath, ["push", "origin", mainName]);
        if (!push.ok) {
          const result: LandResult = {
            ok: false,
            commitSha,
            proof,
            error: `push failed: ${push.out}`,
          };
          writeFileSync(proof, JSON.stringify(result, null, 2), "utf8");
          return result;
        }
      }

      // Best-effort BOARD open→done line rewrite on primary.
      patchBoardDone(input.repoPath, input.ticketId);

      const result: LandResult = { ok: true, commitSha, proof };
      writeFileSync(proof, JSON.stringify(result, null, 2), "utf8");
      return result;
    } catch (error) {
      const result: LandResult = {
        ok: false,
        proof,
        error: error instanceof Error ? error.message : String(error),
      };
      try {
        writeFileSync(proof, JSON.stringify(result, null, 2), "utf8");
      } catch {
        // ignore
      }
      return result;
    }
  }
}

function patchBoardDone(repoPath: string, ticketId: string): void {
  const board = join(repoPath, "issues", "BOARD.md");
  if (!existsSync(board)) return;
  try {
    const text = readFileSync(board, "utf8");
    const re = new RegExp(`(-\\s\\*\\*${ticketId}\\s+)open(\\*\\*)`, "g");
    const next = text.replace(re, `$1done$2`);
    if (next !== text) {
      writeFileSync(board, next, "utf8");
      gitOk(repoPath, ["add", "--", "issues/BOARD.md"]);
      gitOk(repoPath, ["commit", "-m", `Board: mark ${ticketId} done after land.`]);
    }
  } catch {
    // best-effort
  }
}

export function assertPrimaryUntouched(beforeSha: string, repoPath: string): void {
  const head = execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (head !== beforeSha) {
    throw new WaveError("Primary checkout HEAD moved; Wave Runner must not rewrite it.", "primary_dirty");
  }
}
