export type ChainPeer = {
  ticketId: string;
  status: string;
  order: number;
  implSha?: string;
};

/** Latest in-wave DONE dependency SHA (highest order, then ticketId). */
export function predecessorImplSha(
  ticket: { dependsOn: string[] },
  peers: readonly ChainPeer[],
): string | undefined {
  const wanted = new Set(ticket.dependsOn);
  const candidates = peers.filter(
    (peer) => wanted.has(peer.ticketId) && peer.status === "DONE" && Boolean(peer.implSha),
  );
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => b.order - a.order || a.ticketId.localeCompare(b.ticketId));
  return candidates[0]?.implSha;
}
