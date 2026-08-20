/**
 * WR-011: path/product-scoped writer leases.
 * Disjoint scopes may hold IMPL locks at the same time inside one repo.
 */

export type WriterScopeInput = {
  ticketId: string;
  sourcePath?: string;
  /** Optional explicit product/game from ticket frontmatter. */
  product?: string;
  game?: string;
  writerScope?: string;
};

/** Stable scope id for a ticket (no repo path). */
export function deriveWriterScope(input: WriterScopeInput): string {
  if (input.writerScope && input.writerScope.trim()) {
    return sanitize(input.writerScope.trim());
  }
  if (input.product && input.product.trim()) {
    return `product:${sanitize(input.product.trim())}`;
  }
  if (input.game && input.game.trim()) {
    return `game:${sanitize(input.game.trim())}`;
  }
  const src = input.sourcePath ?? "";
  const board = /(?:^|\/)issues\/([^/]+)\//.exec(src);
  if (board?.[1] && board[1] !== "_templates" && board[1] !== "_briefs") {
    return `board:${sanitize(board[1])}`;
  }
  const jam = /game\/jams\/([^/]+)/.exec(src);
  if (jam?.[1]) {
    return `jam:${sanitize(jam[1])}`;
  }
  const prefix = input.ticketId.split("-")[0] || input.ticketId;
  return `prefix:${sanitize(prefix)}`;
}

/** Full lease resource key. */
export function writerLeaseKey(repoPath: string, scope: string): string {
  return `writer:${repoPath}:${scope}`;
}

/** Exclusive land lock for one primary repo (WR-017). */
export function landLockKey(repoPath: string): string {
  return `land:${repoPath}`;
}

/**
 * Back-compat whole-repo key. Prefer writerLeaseKey + deriveWriterScope.
 * @deprecated WR-011
 */
export function repoWriterKey(repoPath: string): string {
  return `repo-writer:${repoPath}`;
}

export function sanitizeWriterToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}

function sanitize(value: string): string {
  return sanitizeWriterToken(value);
}
