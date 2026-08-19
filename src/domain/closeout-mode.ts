import type { FrozenManifest } from "./types.js";

export type CloseoutMode = "apply" | "commit";

export function parseCloseoutMode(raw: unknown): CloseoutMode | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().toLowerCase();
  if (value === "apply" || value === "commit") return value;
  return undefined;
}

/** Ticket `land`/`land_mode` wins, then `WAVE_LAND_MODE`, then commit. Never path-match. */
export function resolveCloseoutMode(input: {
  ticketLand?: string;
  env?: NodeJS.ProcessEnv;
}): CloseoutMode {
  const env = input.env ?? process.env;
  return parseCloseoutMode(input.ticketLand) ?? parseCloseoutMode(env.WAVE_LAND_MODE) ?? "commit";
}

export function ticketLandFromManifest(manifestJson: string, ticketId: string): string | undefined {
  try {
    const manifest = JSON.parse(manifestJson) as FrozenManifest;
    return manifest.tickets.find((ticket) => ticket.ticketId === ticketId)?.landMode;
  } catch {
    return undefined;
  }
}

export function closeoutModeForWaveTicket(
  manifestJson: string,
  ticketId: string,
  env: NodeJS.ProcessEnv = process.env,
): CloseoutMode {
  return resolveCloseoutMode({ ticketLand: ticketLandFromManifest(manifestJson, ticketId), env });
}
