import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import type { ApplyResult, WorkspaceAdapter } from "./ports.js";
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

function blobAt(repo: string, sha: string, path: string): string | undefined {
  try {
    return execFileSync("git", ["-C", repo, "show", `${sha}:${path}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return undefined;
  }
}

function readIfFile(abs: string): string | undefined {
  try {
    if (!existsSync(abs) || !statSync(abs).isFile()) return undefined;
    return readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
}

function writeWorkdirFile(abs: string, contents: string): void {
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents, "utf8");
}

function unlinkIfFile(abs: string): void {
  try {
    if (existsSync(abs) && statSync(abs).isFile()) unlinkSync(abs);
  } catch {
    /* best-effort */
  }
}

function conflictText(ours: string, theirsLabel: string, theirs: string): string {
  return `<<<<<<< ours\n${ours}=======\n${theirs}>>>>>>> ${theirsLabel}\n`;
}

function mergeFile(oursPath: string, basePath: string, theirsPath: string): { conflict: boolean } {
  try {
    execFileSync("git", ["merge-file", "-L", "ours", "-L", "base", "-L", "theirs", oursPath, basePath, theirsPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { conflict: false };
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (typeof status === "number" && status > 0) return { conflict: true };
    return { conflict: true };
  }
}

function applyOnePath(input: {
  repoPath: string;
  worktree: string;
  baseSha: string;
  primaryHead: string;
  relPath: string;
  scratch: string;
}): "ok" | "conflict" {
  const rel = input.relPath;
  const primaryAbs = join(input.repoPath, rel);
  const worktreeAbs = join(input.worktree, rel);
  const baseText = blobAt(input.worktree, input.baseSha, rel);
  const theirsText = readIfFile(worktreeAbs);
  const oursWorkdir = readIfFile(primaryAbs);
  const oursText = oursWorkdir !== undefined ? oursWorkdir : blobAt(input.repoPath, input.primaryHead, rel);

  if (theirsText === undefined && oursText === undefined) return "ok";

  if (theirsText === undefined) {
    if (oursText === baseText) {
      unlinkIfFile(primaryAbs);
      return "ok";
    }
    writeWorkdirFile(primaryAbs, conflictText(oursText ?? "", "theirs (deleted)", ""));
    return "conflict";
  }

  if (oursText === undefined) {
    if (baseText === undefined || theirsText === baseText) {
      writeWorkdirFile(primaryAbs, theirsText);
      return "ok";
    }
    writeWorkdirFile(primaryAbs, conflictText("", "theirs", theirsText));
    return "conflict";
  }

  if (oursText === theirsText || theirsText === baseText) {
    if (oursWorkdir === undefined) writeWorkdirFile(primaryAbs, oursText);
    return "ok";
  }
  if (oursText === baseText) {
    writeWorkdirFile(primaryAbs, theirsText);
    return "ok";
  }

  const oursTmp = join(input.scratch, "ours");
  const baseTmp = join(input.scratch, "base");
  const theirsTmp = join(input.scratch, "theirs");
  writeFileSync(oursTmp, oursText, "utf8");
  writeFileSync(baseTmp, baseText ?? "", "utf8");
  writeFileSync(theirsTmp, theirsText, "utf8");
  const merged = mergeFile(oursTmp, baseTmp, theirsTmp);
  writeWorkdirFile(primaryAbs, readFileSync(oursTmp, "utf8"));
  return merged.conflict ? "conflict" : "ok";
}

export async function applyToWorkdir(input: ApplyToWorkdirInput): Promise<ApplyResult> {
  const proof = durableProofPath(input);
  const finish = (result: ApplyResult, removeTree: boolean): ApplyResult => {
    writeApplyProof(proof, input.worktree, result);
    if (removeTree) removeImplWorktree(input.repoPath, input.worktree);
    return result;
  };
  try {
    const primaryHead = gitOk(input.repoPath, ["rev-parse", "HEAD"]).out || input.baseSha;
    const incoming = listApplyIncoming(input.worktree, input.baseSha);
    const product = incoming.filter((path) => !isBoardProjection(path));
    const conflicts: string[] = [];
    const paths: string[] = [];
    const scratch = mkdtempSync(join(tmpdir(), "wave-apply-"));
    try {
      for (const relPath of product) {
        const outcome = applyOnePath({
          repoPath: input.repoPath,
          worktree: input.worktree,
          baseSha: input.baseSha,
          primaryHead,
          relPath,
          scratch,
        });
        paths.push(relPath);
        if (outcome === "conflict") conflicts.push(relPath);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }

    if (conflicts.length) {
      return finish(
        {
          ok: false,
          proof,
          paths,
          conflicts,
          error: `APPLY_CONFLICT: ${conflicts.join(", ")}`,
          mode: "apply",
        },
        false,
      );
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
