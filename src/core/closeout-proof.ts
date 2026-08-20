import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type CloseoutProofFile = "APPLY.json" | "LAND.json";

export function durableTicketProofPath(input: {
  repoPath: string;
  artifactRoot?: string;
  waveId: string;
  ticketId: string;
  file: CloseoutProofFile;
}): string {
  return join(input.artifactRoot ?? input.repoPath, "tmp", "wave-runner", input.waveId, input.ticketId, input.file);
}

export function readDurableOk(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    const raw = JSON.parse(readFileSync(path, "utf8")) as { ok?: unknown };
    return raw.ok === true;
  } catch {
    return false;
  }
}
