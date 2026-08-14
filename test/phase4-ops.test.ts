import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AI_MUD, GAME_JAM, describeReplacementPath, eligibleForBoundedWave, mapStudioStatus } from "../src/adapters/studio.js";
import { SAFETY, assertBoundedWaveRequest } from "../src/domain/safety.js";
import { auditStore, restoreWaveStore } from "../src/ops/backup.js";
import { createSimulator, seedWave } from "../src/sim/simulator.js";

test("Phase 4: studio mappings and replacement path keep drain disabled", () => {
  assert.equal(mapStudioStatus(GAME_JAM, "plan_review"), "PLAN_REVIEW");
  assert.equal(mapStudioStatus(AI_MUD, "done"), "DONE");
  const replacement = describeReplacementPath();
  assert.equal(replacement.drainEverything, false);
  assert.match(replacement.overnight, /operator/i);
  assert.equal(SAFETY.productionDrainEnabled, false);
  assert.equal(SAFETY.overnightEnabled, false);
  assert.throws(() => assertBoundedWaveRequest({ drainEverything: true, ticketIds: ["X-1"] }), /drain/);
  assert.throws(() => assertBoundedWaveRequest({ overnight: true, ticketIds: ["X-1"] }), /overnight/);
  assert.throws(() => assertBoundedWaveRequest({ ticketIds: [] }), /explicit ticket selection/);
  const gated = eligibleForBoundedWave(
    "---\nid: GJ-1\nstatus: open\nneeds_jason: opinion\n---\n",
    GAME_JAM,
  );
  assert.equal(gated.eligible, false);
});

test("Phase 4: emergency stop, backup, restore, audit", async () => {
  const sim = createSimulator("p4-ops");
  const controller = await seedWave(sim, "wave-ops", ["FX-001"]);
  await controller.start("wave-ops");
  const stopped = controller.emergencyStop("test stop");
  assert.ok(stopped.stopped.includes("wave-ops"));
  const destDir = mkdtempSync(join(tmpdir(), "wave-bak-"));
  const backupPath = join(destDir, "wave-runner-1700000000000.sqlite");
  controller.backup(backupPath);
  const backup = backupPath;
  const restoredPath = join(destDir, "restored.sqlite");
  restoreWaveStore(backup, restoredPath);
  const audit = auditStore(restoredPath);
  assert.equal(audit.schemaVersion, 1);
  assert.equal(audit.waveCount, 1);
  assert.equal(audit.waves[0]?.waveId, "wave-ops");
});

test("Phase 4: projection file is public JSON, not SQLite coupling", async () => {
  const sim = createSimulator("p4-proj");
  const controller = await seedWave(sim, "wave-proj", ["FX-001"]);
  const projection = controller.project();
  const out = join(mkdtempSync(join(tmpdir(), "wave-proj-")), "projection.json");
  writeFileSync(out, JSON.stringify(projection), "utf8");
  assert.equal(projection.authoritative, false);
  assert.ok(!JSON.stringify(projection).includes("sqlite"));
});
