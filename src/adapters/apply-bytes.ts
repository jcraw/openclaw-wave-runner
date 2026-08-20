import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const MAX_BLOB = 32 * 1024 * 1024;
const NUL_SCAN = 8 * 1024;

export function isBinaryBuffer(buf: Buffer | undefined): boolean {
  if (!buf) return false;
  if (buf.subarray(0, NUL_SCAN).includes(0)) return true;
  return !Buffer.from(buf.toString("utf8"), "utf8").equals(buf);
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

function asText(buf: Buffer | undefined): string | undefined {
  return buf === undefined ? undefined : buf.toString("utf8");
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
    return { conflict: typeof status === "number" ? status > 0 : true };
  }
}

function applyBinaryPath(input: {
  primaryAbs: string;
  ours: Buffer | undefined;
  oursWorkdir: Buffer | undefined;
  theirs: Buffer | undefined;
  base: Buffer | undefined;
}): "ok" | "conflict" {
  const { primaryAbs, ours, oursWorkdir, theirs, base } = input;
  if (theirs === undefined && ours === undefined) return "ok";
  if (theirs === undefined) {
    if (bytesEqual(ours, base)) {
      unlinkIfFile(primaryAbs);
      return "ok";
    }
    return "conflict";
  }
  if (ours === undefined) {
    if (base === undefined || bytesEqual(theirs, base)) {
      writeWorkdirBytes(primaryAbs, theirs);
      return "ok";
    }
    return "conflict";
  }
  if (bytesEqual(ours, theirs) || bytesEqual(theirs, base)) {
    if (oursWorkdir === undefined) writeWorkdirBytes(primaryAbs, ours);
    return "ok";
  }
  if (bytesEqual(ours, base)) {
    writeWorkdirBytes(primaryAbs, theirs);
    return "ok";
  }
  return "conflict";
}

function applyTextPath(input: {
  primaryAbs: string;
  scratch: string;
  ours: Buffer | undefined;
  oursWorkdir: Buffer | undefined;
  theirs: Buffer | undefined;
  base: Buffer | undefined;
}): "ok" | "conflict" {
  const oursText = asText(input.ours);
  const theirsText = asText(input.theirs);
  const baseText = asText(input.base);
  if (theirsText === undefined && oursText === undefined) return "ok";
  if (theirsText === undefined) {
    if (oursText === baseText) {
      unlinkIfFile(input.primaryAbs);
      return "ok";
    }
    writeWorkdirBytes(input.primaryAbs, Buffer.from(conflictText(oursText ?? "", "theirs (deleted)", ""), "utf8"));
    return "conflict";
  }
  if (oursText === undefined) {
    if (baseText === undefined || theirsText === baseText) {
      writeWorkdirBytes(input.primaryAbs, input.theirs!);
      return "ok";
    }
    writeWorkdirBytes(input.primaryAbs, Buffer.from(conflictText("", "theirs", theirsText), "utf8"));
    return "conflict";
  }
  if (oursText === theirsText || theirsText === baseText) {
    if (input.oursWorkdir === undefined) writeWorkdirBytes(input.primaryAbs, input.ours!);
    return "ok";
  }
  if (oursText === baseText) {
    writeWorkdirBytes(input.primaryAbs, input.theirs!);
    return "ok";
  }
  const oursTmp = join(input.scratch, "ours");
  const baseTmp = join(input.scratch, "base");
  const theirsTmp = join(input.scratch, "theirs");
  writeFileSync(oursTmp, oursText, "utf8");
  writeFileSync(baseTmp, baseText ?? "", "utf8");
  writeFileSync(theirsTmp, theirsText, "utf8");
  const merged = mergeFile(oursTmp, baseTmp, theirsTmp);
  writeWorkdirBytes(input.primaryAbs, readFileSync(oursTmp));
  return merged.conflict ? "conflict" : "ok";
}

export function applyOnePath(input: {
  repoPath: string;
  worktree: string;
  baseSha: string;
  primaryHead: string;
  relPath: string;
  scratch: string;
}): "ok" | "conflict" {
  const primaryAbs = join(input.repoPath, input.relPath);
  const worktreeAbs = join(input.worktree, input.relPath);
  const base = blobAtBytes(input.worktree, input.baseSha, input.relPath);
  const theirs = readWorkdirBytes(worktreeAbs);
  const oursWorkdir = readWorkdirBytes(primaryAbs);
  const ours = oursWorkdir !== undefined ? oursWorkdir : blobAtBytes(input.repoPath, input.primaryHead, input.relPath);
  const binary = isBinaryBuffer(base) || isBinaryBuffer(ours) || isBinaryBuffer(theirs);
  if (binary) {
    return applyBinaryPath({ primaryAbs, ours, oursWorkdir, theirs, base });
  }
  return applyTextPath({ primaryAbs, scratch: input.scratch, ours, oursWorkdir, theirs, base });
}
