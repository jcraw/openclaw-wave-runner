import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { WaveDatabase } from "../store/database.js";

export function backupWaveStore(dbPath: string, destDir: string, now = Date.now()): string {
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, `wave-runner-${now}.sqlite`);
  if (!existsSync(dbPath)) {
    throw new Error(`wave store not found: ${dbPath}`);
  }
  const live = new WaveDatabase(dbPath);
  try {
    live.db.exec("PRAGMA wal_checkpoint(FULL);");
  } finally {
    live.close();
  }
  copyFileSync(dbPath, dest);
  const copied = new WaveDatabase(dest);
  const schema = copied.schemaVersion();
  copied.close();
  writeFileSync(
    `${dest}.meta.json`,
    JSON.stringify({ source: dbPath, createdAt: now, schema }, null, 2),
  );
  return dest;
}

export function restoreWaveStore(backupPath: string, destPath: string): string {
  copyFileSync(backupPath, destPath);
  return destPath;
}

export function auditStore(dbPath: string) {
  const db = new WaveDatabase(dbPath);
  const waves = db.listWaves();
  return {
    schemaVersion: db.schemaVersion(),
    waveCount: waves.length,
    waves: waves.map((wave) => ({
      waveId: wave.waveId,
      status: wave.status,
      revision: wave.revision,
      launches: wave.counters.launches,
      indeterminateTokens: wave.counters.indeterminateTokens,
      cancelRequested: wave.cancelRequested,
    })),
  };
}
