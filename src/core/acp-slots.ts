import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { LaunchOutbox } from "../domain/types.js";
import { isTerminalWave } from "./state-machine.js";
import { WaveDatabase } from "../store/database.js";

/** Global Grok/Codex/Crawmak ACP sessions. Leave one OpenClaw slot for interactive. */
export const DEFAULT_ACP_SLOTS = 4;

const LIVE = new Set(["PENDING", "CLAIMED", "LAUNCHED", "RECONCILING"]);

export function isLiveOutboxState(state: string): boolean {
  return LIVE.has(state);
}

export function acpSlotCap(waveProviderCap: number, globalCap = DEFAULT_ACP_SLOTS): number {
  const wave = Number.isFinite(waveProviderCap) && waveProviderCap > 0 ? waveProviderCap : globalCap;
  const global = Number.isFinite(globalCap) && globalCap > 0 ? globalCap : DEFAULT_ACP_SLOTS;
  return Math.min(wave, global);
}

export function countLiveProviderSessions(input: {
  items: Array<Pick<LaunchOutbox, "waveId" | "ticketId" | "state">>;
  providerOf: (waveId: string, ticketId: string) => string | undefined;
  provider: string;
}): number {
  let n = 0;
  for (const item of input.items) {
    if (!isLiveOutboxState(item.state)) continue;
    const p = input.providerOf(item.waveId, item.ticketId) ?? "mock";
    if (p === input.provider) n += 1;
  }
  return n;
}

export function countOpenProvider(db: WaveDatabase, provider: string): number {
  const liveWaveIds = new Set(
    db
      .listWaves()
      .filter((wave) => !isTerminalWave(wave.status))
      .map((wave) => wave.waveId),
  );
  return countLiveProviderSessions({
    items: db.listOpenOutbox().filter((item) => liveWaveIds.has(item.waveId)),
    providerOf: (waveId, ticketId) => db.getTicket(waveId, ticketId)?.provider ?? "mock",
    provider,
  });
}

/** Sum in-flight ACP sessions across every repo ledger in WR_SCRATCH/ledgers. */
export function countLiveInLedgerDir(dir: string, provider: string): number {
  if (!dir || !existsSync(dir)) return 0;
  let n = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".sqlite") || name.startsWith("acp-")) continue;
    n += countOpenProvider(new WaveDatabase(join(dir, name)), provider);
  }
  return n;
}

export function countLiveForAdmit(db: WaveDatabase, ledgerDir: string | undefined, provider: string): number {
  const here = countOpenProvider(db, provider);
  if (!ledgerDir) return here;
  const root = ledgerDir.replace(/\/$/, "");
  const inDir = db.path === root || db.path.startsWith(`${root}/`);
  const dirN = countLiveInLedgerDir(root, provider);
  return inDir ? dirN : dirN + here;
}

export function countLiveForAdmitPath(dbPath: string, ledgerDir: string | undefined, provider: string): number {
  return countLiveForAdmit(new WaveDatabase(dbPath), ledgerDir, provider);
}

export function parseAcpSlotsMax(raw: string | undefined, fallback = DEFAULT_ACP_SLOTS): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) return fallback;
  return n;
}
