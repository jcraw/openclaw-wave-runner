import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const MAX_BLOB = 32 * 1024 * 1024;

/** Mergeable text: valid UTF-8 round-trip and no NUL. Missing blobs are not non-text. */
export function isMergeableText(buf: Buffer | undefined): boolean {
  if (!buf) return true;
  if (buf.includes(0)) return false;
  return Buffer.from(buf.toString("utf8"), "utf8").equals(buf);
}

export function isBinaryBuffer(buf: Buffer | undefined): boolean {
  if (!buf) return false;
  return !isMergeableText(buf);
}

export function bytesEqual(a: Buffer | undefined, b: Buffer | undefined): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return a.equals(b);
}

export function readWorkdirBytes(abs: string): Buffer | undefined {
  try {
    if (!existsSync(abs) || !statSync(abs).isFile()) return undefined;
    return readFileSync(abs);
  } catch {
    return undefined;
  }
}

export function writeWorkdirBytes(abs: string, contents: Buffer): void {
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
}

export function unlinkIfFile(abs: string): void {
  try {
    if (existsSync(abs) && statSync(abs).isFile()) unlinkSync(abs);
  } catch {
    /* best-effort */
  }
}

export function blobAtBytes(repo: string, sha: string, path: string): Buffer | undefined {
  try {
    return execFileSync("git", ["-C", repo, "show", `${sha}:${path}`], {
      encoding: "buffer",
      maxBuffer: MAX_BLOB,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const err = error as { code?: string; message?: string };
    if (err.code === "ENOBUFS" || /maxBuffer/i.test(err.message ?? "")) {
      throw new Error(`apply blob exceeds ${MAX_BLOB} bytes: ${path}`);
    }
    return undefined;
  }
}

/** Apply mode: verified worktree wins. Copy or unlink. Never 3-way. Never conflict. */
export function applyOnePath(input: {
  repoPath: string;
  worktree: string;
  relPath: string;
}): "ok" {
  const primaryAbs = join(input.repoPath, input.relPath);
  const theirs = readWorkdirBytes(join(input.worktree, input.relPath));
  if (theirs === undefined) {
    unlinkIfFile(primaryAbs);
    return "ok";
  }
  writeWorkdirBytes(primaryAbs, theirs);
  return "ok";
}
