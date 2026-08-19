import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { overlapWithPrefixes } from "./primary-overlap.js";
import type { ApplyResult, WorkspaceAdapter, WorktreeSpec } from "./ports.js";

export class MockWorkspace implements WorkspaceAdapter {
  primaryIsDirty = false;
  dirtyPaths: string[] = [];
  heads = new Map<string, string>();
  worktrees: string[] = [];
  verifies = 0;
  commits = 0;
  lands = 0;
  applies = 0;
  applyConflicts: string[] = [];
  appliedPaths: string[] = [];

  async currentHead(repoPath: string): Promise<string> {
    return this.heads.get(repoPath) ?? "base-sha-fixture";
  }

  async createImplWorktree(spec: WorktreeSpec): Promise<{ worktree: string; branch: string }> {
    const worktree = join(spec.worktreeRoot, spec.waveId, spec.ticketId);
    const branch = `wave/${spec.waveId}/${spec.ticketId}`;
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, "WORKTREE"), `${spec.baseSha}\n`, "utf8");
    this.worktrees.push(worktree);
    return { worktree, branch };
  }

  async writePlanArtifact(input: {
    repoPath: string;
    waveId: string;
    ticketId: string;
    contents: string;
    artifactRoot?: string;
  }): Promise<string> {
    const path = join(
      input.artifactRoot ?? input.repoPath,
      "tmp",
      "wave-runner",
      input.waveId,
      input.ticketId,
      "PLAN.md",
    );
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, input.contents, "utf8");
    return path;
  }

  async verify(input: {
    worktree: string;
    command: string;
  }): Promise<{ ok: boolean; proof: string; classify?: "runner_verify" | "product_verify" }> {
    this.verifies += 1;
    const ok = input.command !== "false";
    const classify = "product_verify" as const;
    const record = {
      ok,
      command: input.command,
      stdout: ok ? "ok\n" : "",
      stderr: ok ? "" : "verify failed\n",
      output: ok ? "ok\n" : "verify failed\n",
      exitCode: ok ? 0 : 1,
      signal: null,
      timedOut: false,
      durationMs: 0,
      classify,
    };
    const proof = join(input.worktree, "WAVE_VERIFY.json");
    writeFileSync(proof, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    writeFileSync(join(input.worktree, "VERIFY.json"), JSON.stringify({ ok, command: input.command }), "utf8");
    return { ok, proof, classify };
  }

  async commitVerifiedWorktree(input: {
    repoPath: string;
    worktree: string;
    ticketId: string;
    waveId: string;
  }): Promise<{ sha: string }> {
    this.commits += 1;
    const sha = `commit-${input.ticketId}-${this.commits}`;
    writeFileSync(join(input.worktree, "COMMIT"), `${sha}\n`, "utf8");
    return { sha };
  }

  async recordProof(input: { worktree: string; ticketId: string; proof: string }): Promise<string> {
    const path = join(input.worktree, "PROOF.md");
    writeFileSync(path, `# ${input.ticketId}\n\n${input.proof}\n`, "utf8");
    return path;
  }

  async primaryDirty(_repoPath: string): Promise<boolean> {
    return this.primaryIsDirty || this.dirtyPaths.length > 0;
  }

  async primaryDirtyOverlap(input: {
    repoPath: string;
    prefixes: string[];
  }): Promise<{ dirty: string[]; overlap: string[] }> {
    return {
      dirty: [...this.dirtyPaths],
      overlap: overlapWithPrefixes(this.dirtyPaths, input.prefixes),
    };
  }

  async landToMain(input: {
    repoPath: string;
    worktree: string;
    branch?: string;
    ticketId: string;
    waveId: string;
    baseSha: string;
    push?: boolean;
  }): Promise<{ ok: boolean; commitSha?: string; proof: string; error?: string }> {
    this.lands += 1;
    const proof = join(input.worktree, "LAND.json");
    const commitSha = `land-${input.ticketId}-${this.lands}`;
    writeFileSync(proof, JSON.stringify({ ok: true, commitSha, push: Boolean(input.push) }), "utf8");
    return { ok: true, commitSha, proof };
  }

  async applyToWorkdir(input: {
    repoPath: string;
    worktree: string;
    ticketId: string;
    waveId: string;
    baseSha: string;
    artifactRoot?: string;
  }): Promise<ApplyResult> {
    this.applies += 1;
    const proof = join(
      input.artifactRoot ?? input.worktree,
      input.artifactRoot ? join("tmp", "wave-runner", input.waveId, input.ticketId, "APPLY.json") : "APPLY.json",
    );
    mkdirSync(dirname(proof), { recursive: true });
    const conflicts = [...this.applyConflicts];
    const paths = conflicts.length ? [...conflicts] : ["applied.txt"];
    this.appliedPaths = paths;
    const result: ApplyResult = {
      ok: conflicts.length === 0,
      proof,
      paths,
      conflicts,
      mode: "apply",
      ...(conflicts.length ? { error: `APPLY_CONFLICT: ${conflicts.join(", ")}` } : {}),
    };
    writeFileSync(proof, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    try {
      writeFileSync(join(input.worktree, "APPLY.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    } catch {
      /* convenience */
    }
    return result;
  }
}
