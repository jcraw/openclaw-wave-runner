import type { GatewayRequest } from "./gateway-rpc.js";

function asId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  return id || undefined;
}

export function parseAgentIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const raw = root.agents ?? root.agentIds ?? root.ids;
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const id = asId(entry);
      if (id) ids.push(id);
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const id = asId(row.id) ?? asId(row.agentId) ?? asId(row.name);
    if (id) ids.push(id);
  }
  return ids;
}

export async function listGatewayAgentIds(request: GatewayRequest): Promise<string[]> {
  for (const method of ["agents.list", "agents_list"] as const) {
    try {
      const ids = parseAgentIds(await request(method));
      if (ids.length) return ids;
    } catch {
      // Probe miss is fail-closed: treat as no agents.
    }
  }
  return [];
}

/** Never sessions_spawn OpenClaw agent `grok` unless the probe/override lists it. */
export async function resolveAcpAgentId(
  request: GatewayRequest,
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (agentId !== "grok") return agentId;
  const ids = await listGatewayAgentIds(request);
  if (ids.includes("grok")) return "grok";
  const override = env.WAVE_GROK_ACP_AGENT_ID?.trim();
  if (override && ids.includes(override)) return override;
  throw new Error('Unknown agent id "grok"');
}

export function grokAcpListed(ids: string[], env: NodeJS.ProcessEnv = process.env): boolean {
  if (ids.includes("grok")) return true;
  const override = env.WAVE_GROK_ACP_AGENT_ID?.trim();
  return Boolean(override && ids.includes(override));
}
