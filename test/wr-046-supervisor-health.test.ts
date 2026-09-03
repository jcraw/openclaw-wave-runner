import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { countOpenProvider } from "../src/core/acp-slots.js";
import { expireStaleLeases } from "../src/core/lease-release.js";
import { retryImplLand } from "../src/core/land-closeout.js";
import { RUN_OPERATOR_ID } from "../src/core/repo-identity.js";
import { freezeLandMode } from "../src/domain/closeout-mode.js";
import { closeoutModeForWaveTicket } from "../src/domain/closeout-mode.js";
import { FakeClock, SequentialIds } from "../src/domain/clock.js";
import { DEFAULT_LIMITS } from "../src/domain/types.js";
import { WaveDatabase } from "../src/store/database.js";
import { MemoryAuthority } from "../src/core/authority.js";
import { WaveController } from "../src/core/controller.js";
import {
  MockTracker,
  MockUsage,
  MockWorker,
  MockWorkflow,
  SafePolicy,
} from "../src/adapters/mocks.js";
import { MockWorkspace } from "../src/adapters/mock-workspace.js";
import { createSimulator, seedWave } from "../src/sim/simulator.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const supervisorSh = join(root, "scripts", "wave-supervisor.sh");
const healthSh = join(root, "scripts", "supervisor-health.sh");

function withEnv(key: string, value: string | undefined, fn: () => Promise<void> | void) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return Promise.resolve(fn()).finally(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });
}

test("freezeLandMode: YAML omit + WAVE_LAND_MODE=apply sticks after env is cleared", async () => {
  const tickets = freezeLandMode(
    [
      {
        ticketId: "FX-001",
        title: "t",
        contentHash: "a",
        dependsOn: [],
        order: 1,
        sourcePath: "issues/FX-001.md",
        verifyCommand: "true",
      },
    ],
    { WAVE_LAND_MODE: "apply" },
  );
  assert.equal(tickets[0]?.landMode, "apply");
  const manifest = JSON.stringify({ tickets });
  assert.equal(closeoutModeForWaveTicket(manifest, "FX-001", {}), "apply");
});

test("create freezes WAVE_LAND_MODE=apply onto the ticket", async () => {
  await withEnv("WAVE_LAND_MODE", "apply", async () => {
    const sim = createSimulator("wr-046-landmode");
    const ctrl = await seedWave(sim, "W-apply", ["FX-001"]);
    const view = ctrl.inspect("W-apply");
    assert.equal(view.manifest.tickets[0]?.landMode, "apply");
    assert.equal(closeoutModeForWaveTicket(view.wave.manifestJson, "FX-001", {}), "apply");
  });
});

test("YAML land: commit beats env apply at freeze", async () => {
  const tickets = freezeLandMode(
    [
      {
        ticketId: "FX-001",
        title: "t",
        contentHash: "a",
        dependsOn: [],
        order: 1,
        sourcePath: "issues/FX-001.md",
        verifyCommand: "true",
        landMode: "commit",
      },
    ],
    { WAVE_LAND_MODE: "apply" },
  );
  assert.equal(tickets[0]?.landMode, "commit");
});

test("countOpenProvider ignores outbox on terminal waves", () => {
  const dir = mkdtempSync(join(tmpdir(), "wr046-acp-"));
  const db = new WaveDatabase(join(dir, "wave.sqlite"));
  const now = 1_700_000_000_000;
  db.putWave({
    waveId: "dead",
    manifestJson: "{}",
    manifestHash: "x",
    repoPath: "/tmp/r",
    baseSha: "0",
    status: "CANCELLED",
    revision: 1,
    limits: DEFAULT_LIMITS,
    counters: {
      committedTokens: 0,
      reservedTokens: 0,
      indeterminateTokens: 0,
      committedCostMicros: 0,
      reservedCostMicros: 0,
      indeterminateCostMicros: 0,
      launches: 0,
    },
    owner: "none",
    nextAction: "inspect",
    createdAt: now,
    updatedAt: now,
    cancelRequested: true,
    quotaMode: "tokens",
  });
  db.putTicket({
    waveId: "dead",
    ticketId: "FX-001",
    contentHash: "a",
    title: "t",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/FX-001.md",
    stage: "PLAN",
    status: "CANCELLED",
    revision: 1,
    owner: "none",
    nextAction: "inspect",
    provider: "grok",
    verifyCommand: "true",
  });
  db.putOutbox({
    outboxId: "dead:obx:1",
    waveId: "dead",
    ticketId: "FX-001",
    stage: "PLAN",
    attempt: 1,
    idempotencyKey: "dead:FX-001:PLAN:1",
    state: "LAUNCHED",
    fencingGeneration: 1,
    createdAt: now,
    updatedAt: now,
  });
  assert.equal(countOpenProvider(db, "grok"), 0);
});

test("expireStaleLeases adopts IMPL-active lease we hold when pid is dead", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wr046-adopt-"));
  const db = new WaveDatabase(join(dir, "wave.sqlite"));
  const clock = new FakeClock(1_700_000_000_000);
  const deadPid = 1_000_000_001;
  db.putWave({
    waveId: "w1",
    manifestJson: "{}",
    manifestHash: "x",
    repoPath: "/tmp/r",
    baseSha: "0",
    status: "RUNNING",
    revision: 1,
    limits: DEFAULT_LIMITS,
    counters: {
      committedTokens: 0,
      reservedTokens: 0,
      indeterminateTokens: 0,
      committedCostMicros: 0,
      reservedCostMicros: 0,
      indeterminateCostMicros: 0,
      launches: 0,
    },
    owner: "controller",
    nextAction: "tick",
    createdAt: clock.now(),
    updatedAt: clock.now(),
    cancelRequested: false,
    quotaMode: "tokens",
  });
  db.putTicket({
    waveId: "w1",
    ticketId: "T-1",
    contentHash: "a",
    title: "t",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/T-1.md",
    stage: "IMPL",
    status: "IMPLEMENTING",
    revision: 1,
    owner: "controller",
    nextAction: "wait",
    verifyCommand: "true",
  });
  db.putLease({
    resourceKey: "writer:/tmp/r:repo",
    generation: 1,
    holder: "cli-supervised",
    processIdentity: RUN_OPERATOR_ID,
    pid: deadPid,
    waveId: "w1",
    ticketId: "T-1",
    expiresAt: clock.now() + 7_200_000,
    createdAt: clock.now(),
  });
  const ctrl = new WaveController({
    db,
    clock,
    ids: new SequentialIds(),
    tracker: new MockTracker(),
    workflow: new MockWorkflow(),
    worker: new MockWorker(),
    usage: new MockUsage(),
    workspace: new MockWorkspace(),
    policy: new SafePolicy(),
    process: { holder: "cli-supervised", processIdentity: RUN_OPERATOR_ID, pid: process.pid },
    authority: new MemoryAuthority(),
  });
  const n = expireStaleLeases(ctrl);
  assert.equal(n, 0);
  const kept = db.getLease("writer:/tmp/r:repo");
  assert.ok(kept);
  assert.equal(kept?.pid, process.pid);
});

test("land-retry re-acquires a missing writer lease then lands", async () => {
  const sim = createSimulator("wr-046-retry");
  const ctrl = await seedWave(sim, "W-retry", ["FX-001"]);
  const wt = join(dirname(sim.dbPath), "wt-fx");
  mkdirSync(wt, { recursive: true });
  const ticket = ctrl.inspect("W-retry").tickets[0]!;
  ticket.status = "FAILED";
  ticket.stage = "IMPL";
  ticket.implWorktree = wt;
  ticket.result = "controller failed (worker succeeded): stale_fence: writer lease missing";
  ticket.revision += 1;
  ctrl.db.putTicket(ticket);
  const wave = ctrl.inspect("W-retry").wave;
  ctrl.db.putWave({ ...wave, status: "FAILED" });
  const result = await retryImplLand(ctrl, "W-retry", "FX-001");
  assert.equal(result.ok, true);
  assert.match(result.proof ?? "", /landed|applied/i);
  assert.equal(ctrl.inspect("W-retry").tickets[0]?.status, "DONE");
});

test("wave-supervisor.sh refuses an unsafe inherited operator id", () => {
  const scratch = mkdtempSync(join(tmpdir(), "wr046-unsafe-"));
  const r = spawnSync("bash", [supervisorSh], {
    encoding: "utf8",
    env: {
      ...process.env,
      WR: root,
      WR_SCRATCH: scratch,
      WAVE_SKIP_SCRATCH_UUID: "1",
      WAVE_RUNNER_OPERATOR_ID: "/unsafe/path",
      WAVE_SUPERVISOR_PIDFILE: join(scratch, "supervisor.pid"),
    },
  });
  assert.notEqual(r.status, 0);
  assert.match(`${r.stderr}${r.stdout}`, /unsafe/);
});

test("wave-supervisor.sh exits after five tick-all failures", () => {
  const scratch = mkdtempSync(join(tmpdir(), "wr046-fail-"));
  mkdirSync(join(scratch, "ledgers"));
  writeFileSync(join(scratch, "ledgers", "x.sqlite"), "");
  const fake = join(scratch, "fake-cli.mjs");
  writeFileSync(
    fake,
    `const op = process.argv[2];
if (op === "list-live") { process.stdout.write("/tmp/repo"); process.exit(0); }
process.stderr.write("boom\\n"); process.exit(1);
`,
  );
  chmodSync(fake, 0o755);
  const r = spawnSync("bash", [supervisorSh], {
    encoding: "utf8",
    env: {
      ...process.env,
      WR: root,
      PLUGIN_DIR: root,
      WR_SCRATCH: scratch,
      CLI_JS: fake,
      WAVE_SKIP_SCRATCH_UUID: "1",
      WAVE_RUNNER_OPERATOR_ID: RUN_OPERATOR_ID,
      WAVE_SUPERVISOR_PIDFILE: join(scratch, "supervisor.pid"),
      TICK_SLEEP: "0",
      WAVE_IDLE_EXIT_S: "99999",
      STUCK_TICKS: "0",
    },
    timeout: 15_000,
  });
  assert.equal(r.status, 1);
  assert.match(`${r.stderr}${r.stdout}`, /repeated_tick_fail/);
});

test("supervisor_alive is false when heartbeat is stale", () => {
  const scratch = mkdtempSync(join(tmpdir(), "wr046-hb-"));
  writeFileSync(join(scratch, "supervisor.pid"), `${process.pid}\n`);
  writeFileSync(
    join(scratch, "supervisor.heartbeat"),
    JSON.stringify({ ts: 1, pid: process.pid, rc: 0, liveWaves: [], lastError: "" }),
  );
  const r = spawnSync(
    "bash",
    ["-c", `source "${healthSh}"; WR_SCRATCH="${scratch}"; TICK_SLEEP=20; WAVE_SUPERVISOR_PIDFILE="${scratch}/supervisor.pid"; supervisor_alive; echo $?`],
    { encoding: "utf8", env: process.env },
  );
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim().split("\n").pop(), "1");
});
