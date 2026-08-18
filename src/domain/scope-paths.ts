/**
 * Writer-scope → primary path prefixes for dirty-overlap preflight (WR-021).
 * Directory prefixes only. Ticket sourcePath is omitted so tracker mirror
 * of the issue file does not fail-closed our own IMPL. BOARD.md is included
 * only when that file is the ticket sourcePath.
 */

export function scopePaths(writerScope: string, sourcePath?: string): string[] {
  const out: string[] = [];
  const scope = writerScope.trim();
  const game = /^(?:game|jam):(.+)$/.exec(scope);
  if (game?.[1]) out.push(`game/jams/${game[1]}/`);
  const board = /^board:(.+)$/.exec(scope);
  if (board?.[1]) out.push(`issues/${board[1]}/`);
  const src = sourcePath?.replaceAll("\\", "/").trim();
  if (src && /(^|\/)issues\/BOARD\.md$/i.test(src)) out.push(src);
  return [...new Set(out)];
}

export function pathMatchesPrefix(path: string, prefix: string): boolean {
  const p = path.replaceAll("\\", "/");
  const pre = prefix.replaceAll("\\", "/");
  if (pre.endsWith("/")) return p === pre.slice(0, -1) || p.startsWith(pre);
  return p === pre || p.startsWith(`${pre}/`);
}
