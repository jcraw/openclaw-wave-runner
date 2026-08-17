import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  inspectStageArtifacts,
  normalizeArtifactHash,
  sha256Text,
  writeStageTerminal,
} from "../src/adapters/stage-artifacts.js";
import { runWorkspaceVerify } from "../src/adapters/verify-exec.js";
import { GitWorkspace } from "../src/adapters/workspace.js";
import { hasLiveOutbox, nextStuckCount, progressFingerprint } from "../src/core/operator-loop.js";
import { parseWallMs, stageWallMs } from "../src/core/stage-watchdog.js";
import { DEFAULT_LIMITS } from "../src/domain/types.js";
import { createSimulator, seedWave } from "../src/sim/simulator.js";

const LIVE_VIEW = {
  wave: { status: "RUNNING" as const },
  tickets: [{ ticketId: "WR-006", status: "IMPLEMENTING", revision: 3 }],
  outbox: [{ outboxId: "obx-1", state: "LAUNCHED" }],
  leases: [{ resourceKey: "writer:/repo:game:x", holder: "sim", ticketId: "WR-006" }],
};

test("live IMPL outbox is not stuck at threshold", () => {
  const fp = progressFingerprint(LIVE_VIEW);
  assert.equal(hasLiveOutbox(LIVE_VIEW), true);
  assert.deepEqual(nextStuckCount(fp, fp, 2, 3, "RUNNING", hasLiveOutbox(LIVE_VIEW)), {
    count: 0,
    stuck: false,
  });
  for (const state of ["CLAIMED", "RECONCILING"] as const) {
    const view = { ...LIVE_VIEW, outbox: [{ outboxId: "obx-1", state }] };
    assert.equal(hasLiveOutbox(view), true);
    const next = progressFingerprint(view);
    assert.deepEqual(nextStuckCount(next, next, 5, 3, "RUNNING", true), { count: 0, stuck: false });
  }
});

test("WR-019 frozen RUNNING with no open outbox is still stuck", () => {
  const frozen = {
    ...LIVE_VIEW,
    tickets: [{ ticketId: "WR-006", status: "APPROVED", revision: 3 }],
    outbox: [{ outboxId: "obx-1", state: "SETTLED" }],
  };
  assert.equal(hasLiveOutbox(frozen), false);
  const fp = progressFingerprint(frozen);
  assert.deepEqual(nextStuckCount(fp, fp, 2, 3, "RUNNING", hasLiveOutbox(frozen)), {
    count: 3,
    stuck: true,
  });
});

test("plan-gate does not increment stuck (unchanged)", () => {
  const fp = progressFingerprint(LIVE_VIEW);
  assert.deepEqual(nextStuckCount(fp, fp, 5, 3, "AWAITING_PLAN_GATE", false), {
    count: 0,
    stuck: false,
  });
});

test("sha256: prefix on terminal.hash matches PLAN.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "wr020-hash-"));
  const text = "# plan\n";
  const hex = sha256Text(text);
  writeFileSync(join(dir, "PLAN.md"), text, "utf8");
  writeStageTerminal(dir, {
    idempotencyKey: "wave-a:MUD-037:PLAN:1",
    waveId: "wave-a",
    ticketId: "MUD-037",
    stage: "PLAN",
    attempt: 1,
    status: "succeeded",
    hash: `SHA256:${hex}`,
  });
  assert.equal(normalizeArtifactHash(`sha256:${hex}`), hex);
  const truth = inspectStageArtifacts({
    stage: "PLAN",
    outputDir: dir,
    idempotencyKey: "wave-a:MUD-037:PLAN:1",
    waveId: "wave-a",
    ticketId: "MUD-037",
    attempt: 1,
  });
  assert.equal(truth.status, "succeeded");
});

test("verify capture keeps stderr and exitCode (not Command failed only)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wr020-verify-"));
  const ws = new GitWorkspace();
  const result = await ws.verify({ worktree: dir, command: "echo err >&2; exit 2" });
  assert.equal(result.ok, false);
  assert.equal(result.classify, "product_verify");
  const body = JSON.parse(readFileSync(result.proof, "utf8")) as {
    stderr: string;
    exitCode: number | null;
    output: string;
    timedOut: boolean;
  };
  assert.equal(body.exitCode, 2);
  assert.equal(body.timedOut, false);
  assert.match(body.stderr, /err/);
  assert.doesNotMatch(JSON.stringify(body), /^\{"ok":false,"command":.+"output":"Command failed/);
});

test("verify timeout sets timedOut and runner_verify", () => {
  const dir = mkdtempSync(join(tmpdir(), "wr020-timeout-"));
  const ran = runWorkspaceVerify({ worktree: dir, command: "sleep 30", timeoutMs: 50 });
  assert.equal(ran.ok, false);
  assert.equal(ran.timedOut, true);
  assert.equal(ran.classify, "runner_verify");
  const body = JSON.parse(readFileSync(ran.proof, "utf8")) as { timedOut: boolean };
  assert.equal(body.timedOut, true);
});

test("stage walls: defaults and 0 disables", () => {
  assert.equal(stageWallMs("PLAN", {}), 45 * 60 * 1000);
  assert.equal(stageWallMs("IMPL", {}), 90 * 60 * 1000);
  assert.equal(parseWallMs("0", 99), 0);
  assert.equal(stageWallMs("PLAN", { WAVE_PLAN_WALL_MS: "0" }), 0);
});

test.describe("stage watchdog", { concurrency: false }, () => {
test("watchdog: hung PLAN past wall fail-closes with stage_watchdog", async () => {
  const sim = createSimulator("wr020-watchdog");
  sim.worker.completeOnInspect = false;
  const controller = await seedWave(sim, "wave-wd", ["FX-001"], {
    ...DEFAULT_LIMITS,
    maxTokens: 80_000,
    maxLaunches: 8,
    maxRetriesPerStage: 0,
    perStageReservationTokens: 8_000,
  });
  await controller.start("wave-wd");
  let launched = false;
  for (let i = 0; i < 8; i += 1) {
    await controller.tick("wave-wd");
    const view = controller.inspect("wave-wd");
    if (view.outbox.some((item) => item.stage === "PLAN" && item.state === "LAUNCHED")) {
      launched = true;
      break;
    }
  }
  assert.equal(launched, true);
  sim.clock.advance(46 * 60 * 1000);
  await controller.tick("wave-wd");
  const after = controller.inspect("wave-wd");
  const ticket = after.tickets[0]!;
  assert.match(ticket.result ?? "", /stage_watchdog/);
  assert.ok(ticket.status === "FAILED" || ticket.status === "REVISING", ticket.status);
  assert.notEqual(after.wave.status, "RUNNING");
});

test("watchdog 0: wall env 0 does not fail hung PLAN", async () => {
  const prev = process.env.WAVE_PLAN_WALL_MS;
  process.env.WAVE_PLAN_WALL_MS = "0";
  try {
    const sim = createSimulator("wr020-watchdog0");
    sim.worker.completeOnInspect = false;
    const controller = await seedWave(sim, "wave-wd0", ["FX-001"], {
      ...DEFAULT_LIMITS,
      maxTokens: 80_000,
      maxLaunches: 8,
      maxRetriesPerStage: 0,
      perStageReservationTokens: 8_000,
    });
    await controller.start("wave-wd0");
    for (let i = 0; i < 8; i += 1) {
      await controller.tick("wave-wd0");
      if (controller.inspect("wave-wd0").outbox.some((item) => item.state === "LAUNCHED")) break;
    }
    sim.clock.advance(46 * 60 * 1000);
    await controller.tick("wave-wd0");
    const after = controller.inspect("wave-wd0");
    const ticket = after.tickets[0]!;
    assert.equal(ticket.status, "PLANNING");
    assert.doesNotMatch(ticket.result ?? "", /stage_watchdog/);
    assert.ok(after.outbox.some((item) => item.stage === "PLAN" && item.state === "LAUNCHED"));
    assert.equal(after.wave.status, "RUNNING");
  } finally {
    if (prev === undefined) delete process.env.WAVE_PLAN_WALL_MS;
    else process.env.WAVE_PLAN_WALL_MS = prev;
  }
});
});
