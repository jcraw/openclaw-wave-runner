import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { WaveError } from "../domain/errors.js";
import type { LandResult, WorkspaceAdapter, WorktreeSpec } from "./ports.js";
import { enqueueLand, executeLandToMain, git } from "./land-git.js";
import { runWorkspaceVerify } from "./verify-exec.js";
import { commitStagedWorktree, resolveRepoIdentity } from "./worktree-commit.js";

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

  async verify(input: { worktree: string; command: string }) {
    const ran = runWorkspaceVerify(input);
    return { ok: ran.ok, proof: ran.proof, classify: ran.classify, timedOut: ran.timedOut };
  }

  async commitVerifiedWorktree(input: {
    repoPath: string;
    worktree: string;
    ticketId: string;
    waveId: string;
  }): Promise<{ sha: string }> {
    const resolved = resolveRepoIdentity(input.repoPath);
    if (!resolved.ok) throw new Error(resolved.error);
    const committed = commitStagedWorktree(
      input.worktree,
      resolved.identity,
      `Verify ${input.ticketId} (${input.waveId}).`,
    );
    if (!committed.ok) throw new Error(committed.error);
    if (!committed.sha.trim()) throw new Error("empty sha");
    return { sha: committed.sha };
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

  async landToMain(input: {
    repoPath: string;
    worktree: string;
    branch?: string;
    ticketId: string;
    waveId: string;
    baseSha: string;
    push?: boolean;
    artifactRoot?: string;
  }): Promise<LandResult> {
    return enqueueLand(input.repoPath, () => executeLandToMain(input));
  }
}

export function assertPrimaryUntouched(beforeSha: string, repoPath: string): void {
  const head = execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (head !== beforeSha) {
    throw new WaveError("Primary checkout HEAD moved; Wave Runner must not rewrite it.", "primary_dirty");
  }
}
