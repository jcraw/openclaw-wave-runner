import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ApplyResult, WorkspaceAdapter } from "./ports.js";
import { applyOnePath } from "./apply-bytes.js";
import { markBoardDone, markIssueDone, removeImplWorktree } from "./land-git.js";
import { formatGitError, gitOk } from "./worktree-commit.js";

export type ApplyToWorkdirInput = NonNullable<
  Parameters<NonNullable<WorkspaceAdapter["applyToWorkdir"]>>[0]
>;

const APPLY_NOISE = new Set([
  "WAVE_VERIFY.json",
  "LAND.json",
  "APPLY.json",
  "PROOF.md",
  "VERIFY.json",
  "WORKTREE",
  "COMMIT",
]);

function durableProofPath(input: ApplyToWorkdirInput): string {
  return join(input.artifactRoot ?? input.repoPath, "tmp", "wave-runner", input.waveId, input.ticketId, "APPLY.json");
}

function writeApplyProof(durable: string, worktree: string, result: ApplyResult): void {
  const body = `${JSON.stringify(result, null, 2)}\n`;
  mkdirSync(dirname(durable), { recursive: true });
  writeFileSync(durable, body, "utf8");
  try {
    writeFileSync(join(worktree, "APPLY.json"), body, "utf8");
  } catch {
    /* convenience */
  }
}

export function isApplyNoise(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  if (APPLY_NOISE.has(normalized) || APPLY_NOISE.has(normalized.split("/").pop() ?? "")) return true;
  return normalized === "tmp" || normalized.startsWith("tmp/");
}

/** BOARD.md is a projection, not product. Never 3-way it (WR-024 / MUD-039 APPLY_CONFLICT). */
export function isBoardProjection(path: string): boolean {
  return /(^|\/)issues\/(?:.*\/)?BOARD\.md$/i.test(path.replaceAll("\\", "/"));
}

function listedPaths(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function listApplyIncoming(worktree: string, baseSha: string): string[] {
  const names = new Set<string>();
  for (const args of [
    ["diff", "--name-only", baseSha],
    ["diff", "--name-only", "--cached", baseSha],
    ["ls-files", "--others", "--exclude-standard"],
  ]) {
    const got = gitOk(worktree, args);
    if (got.ok) for (const path of listedPaths(got.out)) names.add(path);
  }
  return [...names].filter((path) => !isApplyNoise(path));
}

export async function applyToWorkdir(input: ApplyToWorkdirInput): Promise<ApplyResult> {
  const proof = durableProofPath(input);
  const finish = (result: ApplyResult, removeTree: boolean): ApplyResult => {
    writeApplyProof(proof, input.worktree, result);
    if (removeTree) removeImplWorktree(input.repoPath, input.worktree);
    return result;
  };
  try {
    const incoming = listApplyIncoming(input.worktree, input.baseSha);
    const product = incoming.filter((path) => !isBoardProjection(path));
    const paths: string[] = [];
    for (const relPath of product) {
      applyOnePath({
        repoPath: input.repoPath,
        worktree: input.worktree,
        relPath,
      });
      paths.push(relPath);
    }

    const board = [...markBoardDone(input.repoPath, input.ticketId), ...markIssueDone(input.repoPath, input.ticketId)];
    for (const path of board) {
      if (!paths.includes(path)) paths.push(path);
    }
    return finish({ ok: true, proof, paths, conflicts: [], mode: "apply" }, true);
  } catch (error) {
    return finish(
      {
        ok: false,
        proof,
        paths: [],
        conflicts: [],
        error: formatGitError(error),
        mode: "apply",
      },
      false,
    );
  }
}
