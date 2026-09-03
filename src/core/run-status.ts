import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { isTerminalWave } from "./state-machine.js";
import { WaveDatabase } from "../store/database.js";

export type SupervisorHeartbeat = {
  ts: number;
  pid: number;
  rc: number;
  liveWaves: string[];
  lastError: string;
};

export function heartbeatPath(scratch: string): string {
  return join(scratch.replace(/\/$/, ""), "supervisor.heartbeat");
}

export function pidfilePath(scratch: string): string {
  return join(scratch.replace(/\/$/, ""), "supervisor.pid");
}

export function readHeartbeat(scratch: string): SupervisorHeartbeat | undefined {
  const path = heartbeatPath(scratch);
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as SupervisorHeartbeat;
    if (!Number.isFinite(raw.ts) || !Number.isFinite(raw.pid)) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

export function pidIsLive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function supervisorAlive(scratch: string, tickSleepS = 20): boolean {
  const pidPath = pidfilePath(scratch);
  if (!existsSync(pidPath)) return false;
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  if (!pidIsLive(pid)) return false;
  const hb = readHeartbeat(scratch);
  if (!hb) return false;
  const ageS = Date.now() / 1000 - hb.ts;
  return ageS < 3 * Math.max(1, tickSleepS);
}

export function collectLiveStatus(scratch: string): {
  alive: boolean;
  heartbeat?: SupervisorHeartbeat;
  tickets: Array<{ waveId: string; ticketId: string; stage: string; status: string; nextAction: string }>;
} {
  const tickSleep = Number(process.env.TICK_SLEEP ?? 20);
  const alive = supervisorAlive(scratch, Number.isFinite(tickSleep) ? tickSleep : 20);
  const heartbeat = readHeartbeat(scratch);
  const tickets: Array<{
    waveId: string;
    ticketId: string;
    stage: string;
    status: string;
    nextAction: string;
  }> = [];
  const dir = join(scratch.replace(/\/$/, ""), "ledgers");
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".sqlite") || name.startsWith("acp-")) continue;
      const db = new WaveDatabase(join(dir, name));
      for (const wave of db.listWaves()) {
        if (isTerminalWave(wave.status)) continue;
        for (const ticket of db.listTickets(wave.waveId)) {
          tickets.push({
            waveId: wave.waveId,
            ticketId: ticket.ticketId,
            stage: ticket.stage,
            status: ticket.status,
            nextAction: ticket.nextAction,
          });
        }
      }
    }
  }
  return { alive, ...(heartbeat ? { heartbeat } : {}), tickets };
}
