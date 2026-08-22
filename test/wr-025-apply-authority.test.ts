import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyToWorkdir } from "../src/adapters/apply-workdir.js";
import { bytesEqual, isBinaryBuffer, isMergeableText } from "../src/adapters/apply-bytes.js";
import { git } from "../src/adapters/land-git.js";
import { GitRepoAuthority, gitCommonDir } from "../src/adapters/repo-authority.js";
import { GitWorkspace } from "../src/adapters/workspace.js";
import {
  MockTracker,
  MockUsage,
  MockWorker,
  MockWorkflow,
  SafePolicy,
} from "../src/adapters/mocks.js";
import { applyOnExhaustedImpl } from "../src/core/apply-closeout.js";
import { MemoryAuthority } from "../src/core/authority.js";
import { WaveController } from "../src/core/controller.js";
import { finalizeImplLand, shouldLandPush } from "../src/core/land-closeout.js";
import { advancePendingCloseouts } from "../src/core/pending-closeout.js";
import { FakeClock, SequentialIds } from "../src/domain/clock.js";
import { DEFAULT_LIMITS } from "../src/domain/types.js";
import type { LaunchOutbox } from "../src/domain/types.js";
import { landLockKey } from "../src/domain/writer-scope.js";
import { createSimulator, seedWave } from "../src/sim/simulator.js";
import { WaveDatabase } from "../src/store/database.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
const PNG_CLEAN = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);

function initRepo(extra?: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "wave-wr025-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "wave@example.test"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Wave Runner"], { cwd: dir });
  mkdirSync(join(dir, "issues"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "fixture\n", "utf8");
  writeFileSync(join(dir, "product.txt"), "alpha\nbeta\ngamma\n", "utf8");
  writeFileSync(join(dir, "sprite.png"), PNG);
  writeFileSync(join(dir, "photo.jpg"), JPEG);
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
  writeFileSync(join(dir, "issues", "BOARD.md"), "- **FX-101 open** fixture\n- **FX-102 open** fixture\n", "utf8");
  extra?.(dir);
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

async function makeTree(repo: string, ticketId = "FX-101", waveId = "w1") {
  const ws = new GitWorkspace();
  const created = await ws.createImplWorktree({
    repoPath: repo,
    baseSha: git(repo, ["rev-parse", "HEAD"]),
    waveId,
    ticketId,
    worktreeRoot: join(repo, "tmp", "worktrees"),
  });
  return { ws, ...created, baseSha: git(repo, ["rev-parse", "HEAD"]) };
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

const fastSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 1)));

test("isBinaryBuffer: NUL and utf8 round-trip", () => {
  assert.equal(isBinaryBuffer(PNG), true);
  assert.equal(isBinaryBuffer(PNG_CLEAN), true);
  assert.equal(isBinaryBuffer(JPEG), true);
  assert.equal(isMergeableText(PNG), false);
  assert.equal(isMergeableText(Buffer.from("hello\n", "utf8")), true);
  assert.equal(isMergeableText(undefined), true);
  assert.equal(isBinaryBuffer(Buffer.from("hello\n", "utf8")), false);
  assert.equal(bytesEqual(PNG, Buffer.from(PNG)), true);
  assert.equal(bytesEqual(PNG, JPEG), false);
});

test("apply binary copy: PNG/JPEG bytes match; HEAD unchanged", async () => {
  const repo = initRepo();
  const { worktree, baseSha } = await makeTree(repo);
  const pngTheirs = Buffer.concat([PNG, Buffer.from([0x99])]);
  const jpgTheirs = Buffer.concat([JPEG, Buffer.from([0x88])]);
  writeFileSync(join(worktree, "sprite.png"), pngTheirs);
  writeFileSync(join(worktree, "photo.jpg"), jpgTheirs);
  writeFileSync(join(worktree, "incoming.txt"), "from-wt\n", "utf8");
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
  assert.equal(Buffer.compare(readFileSync(join(repo, "sprite.png")), pngTheirs), 0);
  assert.equal(Buffer.compare(readFileSync(join(repo, "photo.jpg")), jpgTheirs), 0);
  assert.equal(readFileSync(join(repo, "incoming.txt"), "utf8"), "from-wt\n");
  const proof = JSON.parse(readFileSync(join(repo, "tmp", "wave-runner", "w1", "FX-101", "APPLY.json"), "utf8")) as {
    ok?: boolean;
  };
  assert.equal(proof.ok, true);
});

test("apply binary no-NUL JPEG still round-trips", async () => {
  const repo = initRepo();
  const { worktree, baseSha } = await makeTree(repo);
  assert.equal(JPEG.includes(0), false);
  const next = Buffer.concat([JPEG, Buffer.from("JFIF", "utf8")]);
  writeFileSync(join(worktree, "photo.jpg"), next);
  const applied = await applyToWorkdir({
    repoPath: repo,
    worktree,
    ticketId: "FX-101",
    waveId: "w1",
    baseSha,
  });
  assert.equal(applied.ok, true, applied.error);
  assert.equal(Buffer.compare(readFileSync(join(repo, "photo.jpg")), next), 0);
});

test("apply binary overwrite: incoming bytes win, no markers", async () => {
  const repo = initRepo();
  const { worktree, baseSha } = await makeTree(repo);
  const ours = Buffer.concat([PNG, Buffer.from([0x11])]);
  const theirs = Buffer.concat([PNG, Buffer.from([0x22])]);
  writeFileSync(join(repo, "sprite.png"), ours);
  writeFileSync(join(worktree, "sprite.png"), theirs);
  const applied = await applyToWorkdir({
    repoPath: repo,
    worktree,
    ticketId: "FX-101",
    waveId: "w1",
    baseSha,
  });
  assert.equal(applied.ok, true, applied.error);
  assert.equal(Buffer.compare(readFileSync(join(repo, "sprite.png")), theirs), 0);
  const raw = readFileSync(join(repo, "sprite.png"));
  assert.equal(raw.includes(Buffer.from("<<<<<<<")), false);
});

test("apply text regression: disjoint dirty + 3-way clean + BOARD skip", async () => {
  const repo = initRepo();
  const { worktree, baseSha } = await makeTree(repo);
  writeFileSync(join(repo, "notes.txt"), "jason-desk\n", "utf8");
  writeFileSync(join(repo, "product.txt"), "alpha-ours\nbeta\ngamma\n", "utf8");
  writeFileSync(join(worktree, "product.txt"), "alpha\nbeta\ngamma-theirs\n", "utf8");
  writeFileSync(join(repo, "issues", "BOARD.md"), "- **FX-101 open** fixture\n- **FX-999 open** desk\n", "utf8");
  writeFileSync(join(worktree, "issues", "BOARD.md"), "- **FX-101 done** worker\n", "utf8");
  writeFileSync(join(worktree, "incoming.txt"), "from-wt\n", "utf8");
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
  assert.equal(readFileSync(join(repo, "product.txt"), "utf8"), "alpha\nbeta\ngamma-theirs\n");
  assert.equal(readFileSync(join(repo, "notes.txt"), "utf8"), "jason-desk\n");
  const board = readFileSync(join(repo, "issues", "BOARD.md"), "utf8");
  assert.match(board, /FX-101 done/);
  assert.match(board, /FX-999 open/);
  assert.doesNotMatch(board, /<<<<<<</);
});

test("writer cross-wave: shared authority, same scope, one IMPLEMENTING", async () => {
  const shared = new MemoryAuthority();
  const simA = createSimulator("wr025-wa");
  const simB = createSimulator("wr025-wb");
  simA.authority = shared;
  simB.authority = shared;
  simA.worker.hangPrefix = ":IMPL:";
  simB.worker.hangPrefix = ":IMPL:";
  for (const sim of [simA, simB]) {
    sim.tracker.seed({
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
  }
  const a = await seedWave(simA, "wave-a", ["FX-001"], { ...DEFAULT_LIMITS, maxLaunches: 8, perProviderConcurrency: 3 });
  const b = await seedWave(simB, "wave-b", ["FX-001"], { ...DEFAULT_LIMITS, maxLaunches: 8, perProviderConcurrency: 3 });
  await a.start("wave-a");
  await b.start("wave-b");
  for (let i = 0; i < 12; i += 1) {
    await a.tick("wave-a");
    await b.tick("wave-b");
  }
  const implA = a.inspect("wave-a").tickets.filter((t) => t.status === "IMPLEMENTING").length;
  const implB = b.inspect("wave-b").tickets.filter((t) => t.status === "IMPLEMENTING").length;
  assert.equal(implA + implB, 1);
});

test("writer disjoint scopes still IMPL together", async () => {
  const sim = createSimulator("wr025-disjoint");
  sim.tracker.seed({
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
  sim.tracker.seed({
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
  const controller = await seedWave(sim, "wave-par", ["FX-001", "FX-002"], {
    maxTokens: 80_000,
    maxLaunches: 8,
    perProviderConcurrency: 3,
    perStageReservationTokens: 8_000,
  });
  await controller.start("wave-par");
  await controller.runUntilIdle("wave-par");
  assert.equal(controller.inspect("wave-par").tickets.filter((t) => t.status === "DONE").length, 2);
});

test("apply binary add/delete preserve exact bytes", async () => {
  const repo = initRepo();
  const { worktree, baseSha } = await makeTree(repo);
  const added = Buffer.concat([PNG, Buffer.from([0xab, 0xcd])]);
  writeFileSync(join(worktree, "new-sprite.png"), added);
  unlinkSync(join(worktree, "photo.jpg"));
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
  assert.equal(Buffer.compare(readFileSync(join(repo, "new-sprite.png")), added), 0);
  assert.equal(existsSync(join(repo, "photo.jpg")), false);
});

test("apply binary modify-vs-delete: incoming delete wins", async () => {
  const repo = initRepo();
  const { worktree, baseSha } = await makeTree(repo);
  const ours = Buffer.concat([PNG, Buffer.from([0x33])]);
  writeFileSync(join(repo, "sprite.png"), ours);
  unlinkSync(join(worktree, "sprite.png"));
  const applied = await applyToWorkdir({
    repoPath: repo,
    worktree,
    ticketId: "FX-101",
    waveId: "w1",
    baseSha,
  });
  assert.equal(applied.ok, true, applied.error);
  assert.equal(existsSync(join(repo, "sprite.png")), false);
});

test("land serialize two DBs: both product files and BOARD rows", async () => {
  const repo = initRepo((dir) => {
    writeFileSync(join(dir, "a.txt"), "base-a\n", "utf8");
    writeFileSync(join(dir, "b.txt"), "base-b\n", "utf8");
    writeFileSync(
      join(dir, "issues", "FX-102.md"),
      `---
id: FX-102
title: Two
status: open
depends_on: []
verify: "true"
land: apply
---
# FX-102
`,
      "utf8",
    );
  });
  const dbPath = join(repo, "tmp", "shared.sqlite");
  const make = (dbName: string, ticketId: string) => {
    const tracker = new MockTracker();
    tracker.seed({
      ticketId,
      title: ticketId,
      contentHash: "",
      dependsOn: [],
      order: 1,
      sourcePath: `issues/${ticketId}.md`,
      planClass: "safe-policy",
      verifyCommand: "true",
      landMode: "apply",
      writerScope: `ticket:${ticketId}`,
      body: ticketId,
    });
    return new WaveController({
      db: new WaveDatabase(dbPath),
      clock: new FakeClock(),
      ids: new SequentialIds(),
      tracker,
      workflow: new MockWorkflow(),
      worker: new MockWorker(),
      usage: new MockUsage(),
      workspace: new GitWorkspace(),
      policy: new SafePolicy(),
      process: { holder: dbName, processIdentity: dbName, pid: process.pid },
      sleep: fastSleep,
      worktreeRoot: join(repo, "tmp", "worktrees"),
    });
  };
  const ctrlA = make("a.sqlite", "FX-101");
  const ctrlB = make("b.sqlite", "FX-102");
  await ctrlA.create({
    waveId: "wa",
    repoPath: repo,
    ticketIds: ["FX-101"],
    limits: DEFAULT_LIMITS,
  });
  await ctrlB.create({
    waveId: "wb",
    repoPath: repo,
    ticketIds: ["FX-102"],
    limits: DEFAULT_LIMITS,
  });
  const ws = new GitWorkspace();
  const baseSha = git(repo, ["rev-parse", "HEAD"]);
  const treeA = await ws.createImplWorktree({
    repoPath: repo,
    baseSha,
    waveId: "wa",
    ticketId: "FX-101",
    worktreeRoot: join(repo, "tmp", "worktrees"),
  });
  const treeB = await ws.createImplWorktree({
    repoPath: repo,
    baseSha,
    waveId: "wb",
    ticketId: "FX-102",
    worktreeRoot: join(repo, "tmp", "worktrees"),
  });
  writeFileSync(join(treeA.worktree, "a.txt"), "from-a\n", "utf8");
  writeFileSync(join(treeB.worktree, "b.txt"), "from-b\n", "utf8");
  const ta = ctrlA.db.getTicket("wa", "FX-101")!;
  ctrlA.db.putTicket({ ...ta, status: "VERIFYING", implWorktree: treeA.worktree });
  const tb = ctrlB.db.getTicket("wb", "FX-102")!;
  ctrlB.db.putTicket({ ...tb, status: "VERIFYING", implWorktree: treeB.worktree });
  await finalizeImplLand(ctrlA, outbox("wa", "FX-101"));
  await finalizeImplLand(ctrlB, outbox("wb", "FX-102"));
  if (ctrlB.db.getTicket("wb", "FX-102")?.status === "VERIFYING") {
    await ctrlB.tick("wb");
  }
  assert.equal(ctrlA.db.getTicket("wa", "FX-101")?.status, "DONE");
  assert.equal(ctrlB.db.getTicket("wb", "FX-102")?.status, "DONE");
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "from-a\n");
  assert.equal(readFileSync(join(repo, "b.txt"), "utf8"), "from-b\n");
  const board = readFileSync(join(repo, "issues", "BOARD.md"), "utf8");
  assert.match(board, /FX-101 done/);
  assert.match(board, /FX-102 done/);
});

test("exhaust apply defers on land lock then copies", async () => {
  const sim = createSimulator("wr025-exhaust");
  sim.sleep = fastSleep;
  sim.tracker.seed({
    ticketId: "FX-001",
    title: "exhaust",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/FX-001.md",
    planClass: "safe-policy",
    verifyCommand: "true",
    landMode: "apply",
    body: "one",
  });
  const controller = await seedWave(sim, "wave-ex", ["FX-001"], { ...DEFAULT_LIMITS, maxRetriesPerStage: 0 });
  const ticket = controller.db.getTicket("wave-ex", "FX-001")!;
  const wt = join(tmpdir(), "wr025-ex-wt");
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, "APPLY.json"), "{}\n", "utf8");
  controller.db.putTicket({ ...ticket, status: "FAILED", result: "product_verify", implWorktree: wt });
  const resourceKey = landLockKey("/tmp/wave-fixture-repo");
  controller.db.putLease({
    resourceKey,
    generation: 1,
    holder: "other",
    processIdentity: "other-1",
    expiresAt: sim.clock.now() + 60_000,
    createdAt: sim.clock.now(),
    waveId: "other",
    ticketId: "FX-999",
  });
  const item = outbox("wave-ex", "FX-001");
  await applyOnExhaustedImpl(controller, item);
  assert.equal(sim.workspace.applies, 0);
  assert.equal(controller.db.getTicket("wave-ex", "FX-001")?.status, "FAILED");
  controller.db.deleteLease(resourceKey);
  await applyOnExhaustedImpl(controller, item);
  const live = controller.db.getTicket("wave-ex", "FX-001");
  assert.equal(live?.status, "FAILED");
  assert.match(live?.result ?? "", /applied/);
  assert.equal(sim.workspace.applies, 1);
});

test("foreign land lock defers VERIFYING without failing", async () => {
  const sim = createSimulator("wr025-timeout");
  sim.sleep = fastSleep;
  sim.tracker.seed({
    ticketId: "FX-001",
    title: "timeout",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/FX-001.md",
    planClass: "safe-policy",
    verifyCommand: "true",
    body: "one",
  });
  const controller = await seedWave(sim, "wave-to", ["FX-001"]);
  const t = controller.db.getTicket("wave-to", "FX-001")!;
  const wt = join(tmpdir(), "wr025-to-wt");
  mkdirSync(wt, { recursive: true });
  controller.db.putTicket({ ...t, status: "VERIFYING", implWorktree: wt });
  controller.db.putLease({
    resourceKey: landLockKey("/tmp/wave-fixture-repo"),
    generation: 1,
    holder: "other",
    processIdentity: "other-1",
    expiresAt: sim.clock.now() + 60_000,
    createdAt: sim.clock.now(),
    waveId: "other",
    ticketId: "FX-999",
  });
  await finalizeImplLand(controller, outbox("wave-to", "FX-001"));
  const live = controller.db.getTicket("wave-to", "FX-001");
  assert.equal(live?.status, "VERIFYING");
  assert.doesNotMatch(live?.result ?? "", /land lock/);
});

test("commit-land push stays explicit", () => {
  assert.equal(shouldLandPush({}), false);
  assert.equal(shouldLandPush({ WAVE_LAND_PUSH: "1" }), true);
});

test("stale lock with dead pid is harvested", () => {
  const repo = initRepo();
  const auth = new GitRepoAuthority();
  const common = gitCommonDir(repo);
  assert.ok(common);
  const dest = join(common, "wave-runner", "locks", "land.lock");
  mkdirSync(join(common, "wave-runner", "locks"), { recursive: true });
  writeFileSync(
    dest,
    `${JSON.stringify({
      pid: 999999999,
      pidStartTime: "1",
      waveId: "old",
      ticketId: "FX-OLD",
      resourceKey: landLockKey(repo),
      expiresAt: Date.now() + 60_000,
      holder: "dead",
      generation: 3,
    })}\n`,
    "utf8",
  );
  const got = auth.tryAcquire({
    repoPath: repo,
    kind: "land",
    resourceKey: landLockKey(repo),
    waveId: "w1",
    ticketId: "FX-101",
    holder: "live",
    now: Date.now(),
    ttlMs: 60_000,
    pid: process.pid,
  });
  assert.equal(got.ok, true);
  if (got.ok) assert.equal(got.generation, 4);
  assert.equal(existsSync(dest), true);
});

test("GitRepoAuthority fail-closed without git", () => {
  const auth = new GitRepoAuthority();
  const dir = mkdtempSync(join(tmpdir(), "wr025-nogit-"));
  const got = auth.tryAcquire({
    repoPath: dir,
    kind: "land",
    resourceKey: landLockKey(dir),
    waveId: "w",
    ticketId: "T",
    holder: "h",
    now: Date.now(),
    ttlMs: 1000,
  });
  assert.equal(got.ok, false);
  if (!got.ok) assert.match(got.reason, /git-common-dir/);
});
