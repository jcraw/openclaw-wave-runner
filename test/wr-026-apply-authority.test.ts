import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyToWorkdir } from "../src/adapters/apply-workdir.js";
import { git } from "../src/adapters/land-git.js";
import {
  MockTracker,
  MockUsage,
  MockWorker,
  MockWorkflow,
  MockWorkspace,
  SafePolicy,
} from "../src/adapters/mocks.js";
import { GitWorkspace } from "../src/adapters/workspace.js";
import { executeApplyCloseout, labelApplyError } from "../src/core/apply-closeout.js";
import { WaveController } from "../src/core/controller.js";
import { acquireExclusiveLandLock } from "../src/core/land-lock.js";
import { finalizeImplLand } from "../src/core/land-closeout.js";
import { advancePendingCloseouts } from "../src/core/pending-closeout.js";
import {
  canonicalRepoIdentity,
  newWaveId,
  operatorIdentityFromWaveId,
  resolveCliOperatorIdentity,
  resolveSupervisedWaveDb,
} from "../src/core/repo-identity.js";
import { FakeClock, SequentialIds } from "../src/domain/clock.js";
import { DEFAULT_LIMITS } from "../src/domain/types.js";
import type { LaunchOutbox } from "../src/domain/types.js";
import { landLockKey, writerLeaseKey } from "../src/domain/writer-scope.js";
import { openCliController } from "../src/runtime.js";
import { createSimulator, seedWave } from "../src/sim/simulator.js";
import { WaveDatabase } from "../src/store/database.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wave-wr026-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "wave@example.test"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Wave Runner"], { cwd: dir });
  mkdirSync(join(dir, "issues"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "fixture\n", "utf8");
  writeFileSync(join(dir, "sprite.png"), PNG);
  writeFileSync(
    join(dir, "issues", "FX-101.md"),
    `---
id: FX-101
title: Apply fixture
status: open
depends_on: []
verify: "true"
land: apply
---
# FX-101
`,
    "utf8",
  );
  writeFileSync(join(dir, "issues", "BOARD.md"), "- **FX-101 open** fixture\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

async function makeTree(repo: string) {
  const ws = new GitWorkspace();
  const created = await ws.createImplWorktree({
    repoPath: repo,
    baseSha: git(repo, ["rev-parse", "HEAD"]),
    waveId: "w1",
    ticketId: "FX-101",
    worktreeRoot: join(repo, "tmp", "worktrees"),
  });
  return { ...created, baseSha: git(repo, ["rev-parse", "HEAD"]) };
}

function outbox(waveId: string, ticketId: string): LaunchOutbox {
  return {
    outboxId: `${waveId}:obx:${ticketId}`,
    waveId,
    ticketId,
    stage: "IMPL",
    attempt: 1,
    idempotencyKey: `${waveId}:${ticketId}:IMPL:1`,
    state: "SETTLED",
    fencingGeneration: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

test("apply binary add/delete preserve exact bytes; HEAD unchanged", async () => {
  const repo = initRepo();
  const { worktree, baseSha } = await makeTree(repo);
  const added = Buffer.from([0xff, 0x00, 0x03, 0x04, 0x81, 0x0a]);
  writeFileSync(join(worktree, "new.bin"), added);
  unlinkSync(join(worktree, "sprite.png"));
  const before = git(repo, ["rev-parse", "HEAD"]);
  const applied = await applyToWorkdir({
    repoPath: repo,
    worktree,
    ticketId: "FX-101",
    waveId: "w1",
    baseSha,
  });
  assert.equal(applied.ok, true, applied.error);
  assert.equal(git(repo, ["rev-parse", "HEAD"]), before);
  assert.equal(Buffer.compare(readFileSync(join(repo, "new.bin")), added), 0);
  assert.equal(existsSync(join(repo, "sprite.png")), false);
});

test("apply binary modify-vs-delete is APPLY_BINARY_CONFLICT", async () => {
  const repo = initRepo();
  const { worktree, baseSha } = await makeTree(repo);
  const ours = Buffer.concat([PNG, Buffer.from([0x11])]);
  writeFileSync(join(repo, "sprite.png"), ours);
  unlinkSync(join(worktree, "sprite.png"));
  const applied = await applyToWorkdir({
    repoPath: repo,
    worktree,
    ticketId: "FX-101",
    waveId: "w1",
    baseSha,
  });
  assert.equal(applied.ok, false);
  assert.match(applied.error ?? "", /APPLY_BINARY_CONFLICT/);
  assert.equal(Buffer.compare(readFileSync(join(repo, "sprite.png")), ours), 0);
  const listed = execFileSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf8" });
  assert.ok(listed.includes(worktree));
});

test("labelApplyError preserves APPLY_BINARY_CONFLICT", () => {
  assert.equal(labelApplyError("APPLY_BINARY_CONFLICT: sprite.png"), "APPLY_BINARY_CONFLICT: sprite.png");
  assert.equal(labelApplyError("APPLY_CONFLICT: a.txt"), "APPLY_CONFLICT: a.txt");
  assert.equal(labelApplyError("boom"), "APPLY_CONFLICT: boom");
});

test("APPLY_BINARY_CONFLICT survives closeout", async () => {
  const sim = createSimulator("wr026-bin-close");
  const proofDir = mkdtempSync(join(tmpdir(), "wr026-bin-proof-"));
  const proof = join(proofDir, "APPLY.json");
  sim.workspace.applyToWorkdir = async () => {
    const result = {
      ok: false as const,
      proof,
      paths: ["sprite.png"],
      conflicts: ["sprite.png"],
      binaryConflicts: ["sprite.png"],
      error: "APPLY_BINARY_CONFLICT: sprite.png",
      mode: "apply" as const,
    };
    writeFileSync(proof, `${JSON.stringify(result, null, 2)}\n`);
    return result;
  };
  sim.tracker.seed({
    ticketId: "FX-001",
    title: "bin",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/FX-001.md",
    planClass: "safe-policy",
    verifyCommand: "true",
    landMode: "apply",
    body: "one",
  });
  const controller = await seedWave(sim, "wave-bin", ["FX-001"], { ...DEFAULT_LIMITS, maxRetriesPerStage: 0 });
  const ticket = controller.db.getTicket("wave-bin", "FX-001")!;
  const wt = join(tmpdir(), "wr026-bin-wt");
  mkdirSync(wt, { recursive: true });
  controller.db.putTicket({ ...ticket, status: "VERIFYING", implWorktree: wt });
  await executeApplyCloseout(
    controller,
    outbox("wave-bin", "FX-001"),
    controller.db.getWave("wave-bin")!,
    controller.db.getTicket("wave-bin", "FX-001")!,
    { doneOnOk: true },
  );
  const live = controller.db.getTicket("wave-bin", "FX-001");
  assert.equal(live?.status, "FAILED");
  assert.match(live?.result ?? "", /APPLY_BINARY_CONFLICT/);
  assert.doesNotMatch(live?.result ?? "", /^APPLY_CONFLICT:/);
});

test("shared ledger resolver: symlink, trailing slash, distinct OUT_ROOT", () => {
  const repo = initRepo();
  const scratch = mkdtempSync(join(tmpdir(), "wr026-scratch-"));
  const link = `${repo}-link`;
  symlinkSync(repo, link);
  const a = resolveSupervisedWaveDb({ repoPath: repo, scratchDir: scratch, requireScratchUuid: false });
  const b = resolveSupervisedWaveDb({ repoPath: `${repo}/`, scratchDir: scratch, requireScratchUuid: false });
  const c = resolveSupervisedWaveDb({ repoPath: link, scratchDir: scratch, requireScratchUuid: false });
  const otherRoot = mkdtempSync(join(tmpdir(), "wr026-out-"));
  const d = resolveSupervisedWaveDb({
    repoPath: repo,
    scratchDir: scratch,
    requireScratchUuid: false,
    env: { WR_SCRATCH: scratch, OUT_ROOT: otherRoot },
  });
  assert.equal(a.dbPath, b.dbPath);
  assert.equal(a.dbPath, c.dbPath);
  assert.equal(a.dbPath, d.dbPath);
  assert.equal(canonicalRepoIdentity(link), canonicalRepoIdentity(repo));
  assert.equal(canonicalRepoIdentity(`${repo}/`), canonicalRepoIdentity(repo));
  assert.match(a.dbPath, /ledgers\/[a-f0-9]{64}\.sqlite$/);
  assert.equal(writerLeaseKey(canonicalRepoIdentity(link), "s"), writerLeaseKey(canonicalRepoIdentity(repo), "s"));
  assert.equal(landLockKey(canonicalRepoIdentity(`${repo}/`)), landLockKey(canonicalRepoIdentity(repo)));
  unlinkSync(link);
});

test("two CLI controllers share db path and per-wave identity", () => {
  const repo = initRepo();
  const scratch = mkdtempSync(join(tmpdir(), "wr026-cli-"));
  const resolved = resolveSupervisedWaveDb({ repoPath: repo, scratchDir: scratch, requireScratchUuid: false });
  const first = openCliController({
    dbPath: resolved.dbPath,
    repoPath: repo,
    supervised: true,
    waveId: "wave-a",
    worktreeRoot: join(scratch, "wt-a"),
    launcherPath: "/bin/true",
  });
  const second = openCliController({
    dbPath: resolved.dbPath,
    repoPath: `${repo}/`,
    supervised: true,
    waveId: "wave-a",
    worktreeRoot: join(scratch, "wt-b"),
    launcherPath: "/bin/true",
  });
  assert.equal(first.process.processIdentity, "cli-wave:wave-a");
  assert.equal(second.process.processIdentity, first.process.processIdentity);
  assert.equal(first.db.path, second.db.path);
});

test("same-scope IMPL is exclusive in a shared database; disjoint scopes coexist", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wr026-shared-"));
  const db = new WaveDatabase(join(dir, "wave.sqlite"));
  const open = (identity: string) => {
    const tracker = new MockTracker();
    tracker.seed({
      ticketId: "FX-001",
      title: "one",
      contentHash: "",
      dependsOn: [],
      order: 1,
      sourcePath: "issues/godstones/FX-001.md",
      planClass: "safe-policy",
      verifyCommand: "true",
      writerScope: "board:godstones",
      body: "one",
    });
    tracker.seed({
      ticketId: "FX-002",
      title: "two",
      contentHash: "",
      dependsOn: [],
      order: 2,
      sourcePath: "issues/rink_rush/FX-002.md",
      planClass: "safe-policy",
      verifyCommand: "true",
      writerScope: "board:rink_rush",
      body: "two",
    });
    const worker = new MockWorker();
    worker.hangPrefix = ":IMPL:";
    return new WaveController({
      db,
      clock: new FakeClock(),
      ids: new SequentialIds(),
      tracker,
      workflow: new MockWorkflow(),
      worker,
      usage: new MockUsage(),
      workspace: new MockWorkspace(),
      policy: new SafePolicy(),
      process: { holder: "cli-supervised", processIdentity: identity, pid: process.pid },
      worktreeRoot: join(dir, "worktrees"),
    });
  };
  const a = open("cli-wave:wa");
  const b = open("cli-wave:wb");
  await a.create({
    waveId: "wa",
    repoPath: "/tmp/wave-fixture-repo",
    ticketIds: ["FX-001"],
    limits: { ...DEFAULT_LIMITS, maxLaunches: 8, perProviderConcurrency: 3 },
  });
  await b.create({
    waveId: "wb",
    repoPath: "/tmp/wave-fixture-repo",
    ticketIds: ["FX-001"],
    limits: { ...DEFAULT_LIMITS, maxLaunches: 8, perProviderConcurrency: 3 },
  });
  await a.start("wa");
  await b.start("wb");
  for (let i = 0; i < 8; i += 1) {
    await a.tick("wa");
    await b.tick("wb");
  }
  const implA = a.inspect("wa").tickets.filter((t) => t.status === "IMPLEMENTING").length;
  const implB = b.inspect("wb").tickets.filter((t) => t.status === "IMPLEMENTING").length;
  assert.equal(implA + implB, 1);
  const c = open("cli-wave:wc");
  await c.create({
    waveId: "wc",
    repoPath: "/tmp/wave-fixture-repo",
    ticketIds: ["FX-002"],
    limits: { ...DEFAULT_LIMITS, maxLaunches: 8, perProviderConcurrency: 3 },
  });
  await c.start("wc");
  for (let i = 0; i < 8; i += 1) await c.tick("wc");
  assert.equal(c.inspect("wc").tickets.filter((t) => t.status === "IMPLEMENTING").length, 1);
});

test("same-owner land hold refreshes; foreign deny defers without dropping writer lease", async () => {
  const sim = createSimulator("wr026-hold");
  sim.tracker.seed({
    ticketId: "FX-001",
    title: "hold",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/FX-001.md",
    planClass: "safe-policy",
    verifyCommand: "true",
    landMode: "apply",
    body: "one",
  });
  const controller = await seedWave(sim, "wave-hold", ["FX-001"]);
  const t = controller.db.getTicket("wave-hold", "FX-001")!;
  const wt = join(tmpdir(), "wr026-hold-wt");
  mkdirSync(wt, { recursive: true });
  controller.db.putTicket({ ...t, status: "VERIFYING", implWorktree: wt });
  const wave = controller.db.getWave("wave-hold")!;
  const first = await acquireExclusiveLandLock(controller, wave, "FX-001");
  assert.equal(first.ok, true);
  const again = await acquireExclusiveLandLock(controller, wave, "FX-001");
  assert.equal(again.ok, true);
  if (first.ok && again.ok) assert.equal(again.generation, first.generation);
  const otherTicket = await acquireExclusiveLandLock(controller, wave, "FX-999");
  assert.equal(otherTicket.ok, false);

  const sim2 = createSimulator("wr026-deny");
  sim2.tracker.seed({
    ticketId: "FX-001",
    title: "deny",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/FX-001.md",
    planClass: "safe-policy",
    verifyCommand: "true",
    body: "one",
  });
  const other = await seedWave(sim2, "wave-deny", ["FX-001"]);
  const td = other.db.getTicket("wave-deny", "FX-001")!;
  const wtd = join(tmpdir(), "wr026-deny-wt");
  mkdirSync(wtd, { recursive: true });
  const wkey = writerLeaseKey("/tmp/wave-fixture-repo", td.writerScope ?? "prefix:FX");
  other.db.putLease({
    resourceKey: wkey,
    generation: 1,
    holder: other.process.holder,
    processIdentity: other.process.processIdentity,
    expiresAt: sim2.clock.now() + 60_000,
    createdAt: sim2.clock.now(),
    waveId: "wave-deny",
    ticketId: "FX-001",
  });
  other.db.putTicket({ ...td, status: "VERIFYING", implWorktree: wtd });
  other.db.putLease({
    resourceKey: landLockKey("/tmp/wave-fixture-repo"),
    generation: 1,
    holder: "other",
    processIdentity: "cli-wave:other",
    expiresAt: sim2.clock.now() + 60_000,
    createdAt: sim2.clock.now(),
    waveId: "other",
    ticketId: "FX-999",
  });
  await finalizeImplLand(other, outbox("wave-deny", "FX-001"));
  assert.equal(other.db.getTicket("wave-deny", "FX-001")?.status, "VERIFYING");
  assert.ok(other.db.getLease(wkey));
});

test("restart closeout is idempotent after durable proof with worktree gone", async () => {
  const sim = createSimulator("wr026-restart");
  sim.tracker.seed({
    ticketId: "FX-001",
    title: "restart",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/FX-001.md",
    planClass: "safe-policy",
    verifyCommand: "true",
    landMode: "apply",
    body: "one",
  });
  const first = await seedWave(sim, "wave-rs", ["FX-001"]);
  const ticket = first.db.getTicket("wave-rs", "FX-001")!;
  first.db.putOutbox({ ...outbox("wave-rs", "FX-001"), state: "SETTLED" });
  const proof = join("/tmp/wave-fixture-repo", "tmp", "wave-runner", "wave-rs", "FX-001", "APPLY.json");
  mkdirSync(join("/tmp/wave-fixture-repo", "tmp", "wave-runner", "wave-rs", "FX-001"), { recursive: true });
  writeFileSync(
    proof,
    `${JSON.stringify({ ok: true, proof, paths: ["x"], conflicts: [], mode: "apply" }, null, 2)}\n`,
  );
  first.db.putTicket({ ...ticket, status: "VERIFYING", implWorktree: undefined });
  const recovered = sim.open();
  await recovered.tick("wave-rs");
  const live = recovered.db.getTicket("wave-rs", "FX-001");
  assert.equal(live?.status, "DONE");
  assert.match(live?.result ?? "", /verified\+applied/);
  await advancePendingCloseouts(recovered, "wave-rs");
  assert.equal(recovered.db.getTicket("wave-rs", "FX-001")?.status, "DONE");
});

test("wave ids and operator identities are distinct and stable", () => {
  const ids = new Set(Array.from({ length: 40 }, () => newWaveId("BL")));
  assert.equal(ids.size, 40);
  assert.equal(operatorIdentityFromWaveId("W1"), "cli-wave:W1");
  assert.equal(
    resolveCliOperatorIdentity({ supervised: true, waveId: "W1" }),
    resolveCliOperatorIdentity({ supervised: true, env: { WAVE_RUNNER_OPERATOR_ID: "cli-wave:W1" } }),
  );
  assert.notEqual(
    resolveCliOperatorIdentity({ supervised: true, waveId: "W1" }),
    resolveCliOperatorIdentity({ supervised: true, waveId: "W2" }),
  );
  assert.throws(() => resolveCliOperatorIdentity({ supervised: true }));
});

test("supervised wrappers use WAVE_DB and collision-resistant wave ids", () => {
  const operator = readFileSync("scripts/wave-operator.sh", "utf8");
  const wave = readFileSync("scripts/run-backlog-wave.sh", "utf8");
  const par = readFileSync("scripts/run-backlog-parallel.sh", "utf8");
  assert.match(operator, /--db "\$WAVE_DB"/);
  assert.doesNotMatch(operator, /--db "\$OUT_DIR\/wave\.sqlite"/);
  assert.match(operator, /WAVE_RUNNER_OPERATOR_ID/);
  assert.match(operator, /VERIFYING/);
  assert.match(wave, /%N/);
  assert.match(par, /%N/);
});
