import { pathMatchesPrefix } from "../domain/scope-paths.js";
import { gitOk } from "./worktree-commit.js";

function listedPaths(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function listDirtyPaths(repoPath: string): string[] {
  const names = new Set<string>();
  for (const args of [
    ["diff", "--name-only"],
    ["diff", "--name-only", "--cached"],
    ["ls-files", "--others", "--exclude-standard"],
  ]) {
    const got = gitOk(repoPath, args);
    if (got.ok) for (const p of listedPaths(got.out)) names.add(p);
  }
  return [...names];
}

export function listIncomingPaths(repoPath: string, from: string, to: string): string[] {
  const got = gitOk(repoPath, ["diff", "--name-only", from, to]);
  return got.ok ? listedPaths(got.out) : [];
}

export function overlapPaths(incoming: string[], dirty: string[]): string[] {
  const dirtySet = new Set(dirty);
  return incoming.filter((p) => dirtySet.has(p));
}

export function overlapWithPrefixes(dirty: string[], prefixes: string[]): string[] {
  return dirty.filter((p) => prefixes.some((pre) => pathMatchesPrefix(p, pre)));
}

export function computePrimaryDirtyOverlap(
  repoPath: string,
  prefixes: string[],
): { dirty: string[]; overlap: string[] } {
  const dirty = listDirtyPaths(repoPath);
  return { dirty, overlap: overlapWithPrefixes(dirty, prefixes) };
}
