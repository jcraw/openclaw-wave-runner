import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SAFETY,
  assertBoundedWaveRequest,
  assertNotProductionWorker,
  assertSupervisedBoundedLaunch,
  assertSupervisedOneTicketLaunch,
} from "../src/domain/safety.js";
import { SafetyGateError } from "../src/domain/errors.js";
import { auditStore, backupWaveStore, restoreWaveStore } from "../src/ops/backup.js";
import { WaveDatabase } from "../src/store/database.js";

test("safety: refuses drain-everything / overnight / empty selection", () => {
  assert.equal(SAFETY.productionDrainEnabled, false);
  assert.equal(SAFETY.overnightEnabled, false);
  assert.equal(SAFETY.unrestrictedDrainEnabled, false);
  assert.equal(SAFETY.recurringLlmPollingEnabled, false);

  assert.throws(
    () => assertBoundedWaveRequest({ drainEverything: true, ticketIds: ["T-1"] }),
    SafetyGateError,
  );
  assert.throws(
    () => assertBoundedWaveRequest({ overnight: true, ticketIds: ["T-1"] }),
    SafetyGateError,
  );
  assert.throws(
    () => assertBoundedWaveRequest({ recurringLlmPolling: true, ticketIds: ["T-1"] }),
    SafetyGateError,
  );
  assert.throws(() => assertBoundedWaveRequest({ ticketIds: [] }), SafetyGateError);
  assert.doesNotThrow(() => assertBoundedWaveRequest({ ticketIds: ["T-1"] }));
});

test("safety: production worker profile is refused", () => {
  assert.throws(() => assertNotProductionWorker("production"), SafetyGateError);
  assert.doesNotThrow(() => assertNotProductionWorker("disposable"));
});

test("safety: supervised launch enforces operator action, caps, isolation", () => {
  const base = {
    ticketIds: ["A", "B"],
    operatorAction: true,
    isolatedWorktree: true,
    limits: {
      maxLaunches: 4,
      maxTokens: 10_000,
      maxWallTimeMs: 60_000,
      repoConcurrency: 1,
    },
  };
  assert.doesNotThrow(() => assertSupervisedBoundedLaunch(base));

  assert.throws(
    () => assertSupervisedBoundedLaunch({ ...base, operatorAction: false }),
    SafetyGateError,
  );
  assert.throws(
    () => assertSupervisedBoundedLaunch({ ...base, isolatedWorktree: false }),
    SafetyGateError,
  );
  assert.throws(
    () => assertSupervisedBoundedLaunch({ ...base, deployPush: true }),
    SafetyGateError,
  );
  assert.throws(
    () => assertSupervisedBoundedLaunch({ ...base, gatewayMutate: true }),
    SafetyGateError,
  );
  assert.throws(
    () =>
      assertSupervisedBoundedLaunch({
        ...base,
        ticketIds: ["A", "B", "C", "D"],
      }),
    SafetyGateError,
  );
  assert.throws(
    () => assertSupervisedBoundedLaunch({ ...base, ticketIds: ["A", "A"] }),
    SafetyGateError,
  );
  assert.throws(
    () =>
      assertSupervisedBoundedLaunch({
        ...base,
        limits: { ...base.limits, maxLaunches: SAFETY.supervisedMaxLaunches + 1 },
      }),
    SafetyGateError,
  );
  assert.throws(
    () =>
      assertSupervisedBoundedLaunch({
        ...base,
        limits: { ...base.limits, repoConcurrency: 2 },
      }),
    SafetyGateError,
  );
  assert.throws(
    () => assertSupervisedOneTicketLaunch(base),
    SafetyGateError,
  );
  assert.doesNotThrow(() =>
    assertSupervisedOneTicketLaunch({ ...base, ticketIds: ["ONLY"] }),
  );
});

test("backup/restore/audit round-trip a real wave store", () => {
  const dir = mkdtempSync(join(tmpdir(), "wave-backup-"));
  try {
    const src = join(dir, "wave.sqlite");
    const db = new WaveDatabase(src);
    db.close();

    const destDir = join(dir, "backups");
    const backupPath = backupWaveStore(src, destDir, 1_700_000_000_000);
    assert.equal(existsSync(backupPath), true);
    assert.equal(existsSync(`${backupPath}.meta.json`), true);
    const meta = JSON.parse(readFileSync(`${backupPath}.meta.json`, "utf8")) as {
      schema: number;
      source: string;
    };
    assert.equal(typeof meta.schema, "number");
    assert.equal(meta.source, src);

    const restored = join(dir, "restored.sqlite");
    restoreWaveStore(backupPath, restored);
    const audit = auditStore(restored);
    assert.equal(typeof audit.schemaVersion, "number");
    assert.equal(audit.waveCount, 0);
    assert.deepEqual(audit.waves, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
