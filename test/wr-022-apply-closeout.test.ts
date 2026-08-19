import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyToWorkdir } from "../src/adapters/apply-workdir.js";
import { git } from "../src/adapters/land-git.js";
import { MarkdownTracker } from "../src/adapters/markdown-tracker.js";
import { GitWorkspace } from "../src/adapters/workspace.js";
import { closeoutLabel, formatDrainTable, outcomeFromTicket } from "../src/core/drain-summary.js";
import { shouldLandPush } from "../src/core/land-closeout.js";
import { resolveCloseoutMode } from "../src/domain/closeout-mode.js";
import { DEFAULT_LIMITS } from "../src/domain/types.js";
import { createSimulator, seedWave } from "../src/sim/simulator.js";

const LIMITS = { ...DEFAULT_LIMITS, maxLaunches: 8, maxRetriesPerStage: 0 };

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wave-wr022-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "wave@example.test"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Wave Runner"], { cwd: dir });
  mkdirSync(join(dir, "issues"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "fixture\n", "utf8");
  writeFileSync(join(dir, "product.txt"), "alpha\nbeta\ngamma\n", "utf8");
  writeFileSync(
    join(dir, "issues", "FX-101-one.md"),
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
  return { ws, ...created, baseSha: git(repo, ["rev-parse", "HEAD"]) };
}

function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

test("resolveCloseoutMode: ticket wins, env wins, default commit", () => {
  assert.equal(resolveCloseoutMode({ ticketLand: "apply", env: { WAVE_LAND_MODE: "commit" } }), "apply");
  assert.equal(resolveCloseoutMode({ ticketLand: "commit", env: { WAVE_LAND_MODE: "apply" } }), "commit");
  assert.equal(resolveCloseoutMode({ env: { WAVE_LAND_MODE: "apply" } }), "apply");
  assert.equal(resolveCloseoutMode({ env: {} }), "commit");
  assert.equal(resolveCloseoutMode({ ticketLand: "nope", env: {} }), "commit");
});

test("ticket land: commit beats drain default apply", () => {
  assert.equal(
    resolveCloseoutMode({ ticketLand: "commit", env: { WAVE_LAND_MODE: "apply" } }),
    "commit",
  );
});

test("apply disjoint dirty: HEAD same, incoming in workdir, APPLY.json ok", async () => {
  const repo = initRepo();
  const { worktree, baseSha } = await makeTree(repo);
  writeFileSync(join(repo, "notes.txt"), "jason-desk\n", "utf8");
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
  assert.equal(applied.mode, "apply");
  assert.equal(git(repo, ["rev-parse", "HEAD"]), before);
  assert.equal(readFileSync(join(repo, "incoming.txt"), "utf8"), "from-wt\n");
  assert.equal(readFileSync(join(repo, "notes.txt"), "utf8"), "jason-desk\n");
  const proof = join(repo, "tmp", "wave-runner", "w1", "FX-101", "APPLY.json");
  assert.equal(applied.proof, proof);
  assert.equal(existsSync(proof), true);
  const body = JSON.parse(readFileSync(proof, "utf8")) as { ok?: boolean; mode?: string };
  assert.equal(body.ok, true);
  assert.equal(body.mode, "apply");
  assert.match(readFileSync(join(repo, "issues", "BOARD.md"), "utf8"), /FX-101 done/);
  const listed = execFileSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf8" });
  assert.ok(!listed.includes(worktree));
});

test("apply 3-way clean: both edits kept; DONE-shaped proof", async () => {
  const repo = initRepo();
  const { worktree, baseSha } = await makeTree(repo);
  writeFileSync(join(repo, "product.txt"), "alpha-ours\nbeta\ngamma\n", "utf8");
  writeFileSync(join(worktree, "product.txt"), "alpha\nbeta\ngamma-theirs\n", "utf8");
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
  assert.equal(readFileSync(join(repo, "product.txt"), "utf8"), "alpha-ours\nbeta\ngamma-theirs\n");
});

test("apply conflict: markers, APPLY_CONFLICT, worktree kept, no silent overwrite", async () => {
  const repo = initRepo();
  const { worktree, baseSha } = await makeTree(repo);
  writeFileSync(join(repo, "product.txt"), "alpha-ours\nbeta\ngamma\n", "utf8");
  writeFileSync(join(worktree, "product.txt"), "alpha-theirs\nbeta\ngamma\n", "utf8");
  const before = git(repo, ["rev-parse", "HEAD"]);
  const applied = await applyToWorkdir({
    repoPath: repo,
    worktree,
    ticketId: "FX-101",
    waveId: "w1",
    baseSha,
  });
  assert.equal(applied.ok, false);
  assert.match(applied.error ?? "", /APPLY_CONFLICT/);
  assert.ok(applied.conflicts.includes("product.txt"));
  assert.equal(git(repo, ["rev-parse", "HEAD"]), before);
  const merged = readFileSync(join(repo, "product.txt"), "utf8");
  assert.match(merged, /<<<<<<< ours/);
  assert.match(merged, /alpha-ours/);
  assert.match(merged, /alpha-theirs/);
  assert.doesNotMatch(merged, /^alpha-theirs\nbeta\ngamma\n$/);
  const listed = execFileSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf8" });
  assert.ok(listed.includes(worktree));
});

test("commit mode still commit-lands; push stays explicit", async () => {
  assert.equal(shouldLandPush({}), false);
  assert.equal(shouldLandPush({ WAVE_LAND_PUSH: "1" }), true);
  const sim = createSimulator("wr022-commit");
  sim.tracker.seed({
    ticketId: "FX-001",
    title: "commit",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/FX-001.md",
    planClass: "safe-policy",
    verifyCommand: "true",
    landMode: "commit",
    body: "one",
  });
  const controller = await seedWave(sim, "wave-commit", ["FX-001"], LIMITS);
  await controller.start("wave-commit");
  await controller.runUntilIdle("wave-commit");
  const ticket = controller.inspect("wave-commit").tickets[0];
  assert.equal(ticket?.status, "DONE");
  assert.match(ticket?.result ?? "", /verified\+landed/);
  assert.equal(sim.workspace.lands, 1);
  assert.equal(sim.workspace.applies, 0);
});

test("apply skips dirty admit; commit still fail-closed", async () => {
  const applySim = createSimulator("wr022-apply-dirty");
  applySim.workspace.dirtyPaths = ["game/jams/rink_rush/Player.gd"];
  applySim.tracker.seed({
    ticketId: "FX-001",
    title: "apply-dirty",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/rink_rush/FX-001.md",
    planClass: "safe-policy",
    verifyCommand: "true",
    writerScope: "game:rink_rush",
    landMode: "apply",
    body: "one",
  });
  const applyCtrl = await seedWave(applySim, "wave-apply-dirty", ["FX-001"], LIMITS);
  await applyCtrl.start("wave-apply-dirty");
  await applyCtrl.runUntilIdle("wave-apply-dirty");
  const applied = applyCtrl.inspect("wave-apply-dirty");
  assert.equal(applied.tickets[0]?.status, "DONE");
  assert.match(applied.tickets[0]?.result ?? "", /verified\+applied/);
  assert.ok(applied.outbox.some((o) => o.stage === "IMPL"));
  assert.equal(applySim.workspace.applies, 1);
  assert.equal(applySim.workspace.lands, 0);

  const commitSim = createSimulator("wr022-commit-dirty");
  commitSim.workspace.dirtyPaths = ["game/jams/rink_rush/Player.gd"];
  commitSim.tracker.seed({
    ticketId: "FX-001",
    title: "commit-dirty",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/rink_rush/FX-001.md",
    planClass: "safe-policy",
    verifyCommand: "true",
    writerScope: "game:rink_rush",
    landMode: "commit",
    body: "one",
  });
  const commitCtrl = await seedWave(commitSim, "wave-commit-dirty", ["FX-001"], LIMITS);
  await commitCtrl.start("wave-commit-dirty");
  await commitCtrl.runUntilIdle("wave-commit-dirty");
  const blocked = commitCtrl.inspect("wave-commit-dirty");
  assert.equal(blocked.tickets[0]?.status, "FAILED");
  assert.match(blocked.tickets[0]?.result ?? "", /primary_dirty_overlap/);
  assert.ok(!blocked.outbox.some((o) => o.stage === "IMPL"));
  assert.equal(commitSim.workspace.lands, 0);
});

test("FIX brief: 2nd IMPL prompt contains verify command + body", async () => {
  const sim = createSimulator("wr022-fix");
  sim.tracker.seed({
    ticketId: "FX-001",
    title: "fix-brief",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/FX-001.md",
    planClass: "safe-policy",
    verifyCommand: "false",
    landMode: "apply",
    body: "one",
  });
  const controller = await seedWave(sim, "wave-fix", ["FX-001"], {
    ...DEFAULT_LIMITS,
    maxLaunches: 8,
    maxRetriesPerStage: 1,
  });
  await controller.start("wave-fix");
  await controller.runUntilIdle("wave-fix", 24);
  const impl = sim.worker.intents.filter((intent) => intent.stage === "IMPL");
  assert.ok(impl.length >= 2, `expected retry IMPL, got ${impl.length}`);
  const second = impl[1]?.prompt ?? "";
  assert.match(second, /# FIX FX-001/);
  assert.match(second, /command: false/);
  assert.match(second, /product_verify/);
  assert.match(second, /verify failed/);
  const attemptDir = impl[1]?.outputDir;
  assert.ok(attemptDir);
  assert.equal(existsSync(join(attemptDir, "WAVE_VERIFY.json")), true);
});

test("exhaust apply: red verify copies files, FAILED, not a land commit", async () => {
  const sim = createSimulator("wr022-exhaust");
  sim.tracker.seed({
    ticketId: "FX-001",
    title: "exhaust",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/FX-001.md",
    planClass: "safe-policy",
    verifyCommand: "false",
    landMode: "apply",
    body: "one",
  });
  const controller = await seedWave(sim, "wave-exhaust", ["FX-001"], LIMITS);
  await controller.start("wave-exhaust");
  await controller.runUntilIdle("wave-exhaust");
  const ticket = controller.inspect("wave-exhaust").tickets[0];
  assert.equal(ticket?.status, "FAILED");
  assert.notEqual(ticket?.status, "DONE");
  assert.match(ticket?.result ?? "", /product_verify/);
  assert.match(ticket?.result ?? "", /applied/);
  assert.equal(sim.workspace.applies, 1);
  assert.equal(sim.workspace.lands, 0);
  assert.ok(ticket?.implWorktree);
  assert.equal(existsSync(join(ticket.implWorktree, "APPLY.json")), true);
});

test("exhaust commit: red verify does not land", async () => {
  const sim = createSimulator("wr022-exhaust-commit");
  sim.tracker.seed({
    ticketId: "FX-001",
    title: "exhaust-commit",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/FX-001.md",
    planClass: "safe-policy",
    verifyCommand: "false",
    landMode: "commit",
    body: "one",
  });
  const controller = await seedWave(sim, "wave-ex-c", ["FX-001"], LIMITS);
  await controller.start("wave-ex-c");
  await controller.runUntilIdle("wave-ex-c");
  const ticket = controller.inspect("wave-ex-c").tickets[0];
  assert.equal(ticket?.status, "FAILED");
  assert.match(ticket?.result ?? "", /product_verify/);
  assert.doesNotMatch(ticket?.result ?? "", /applied/);
  assert.equal(sim.workspace.lands, 0);
  assert.equal(sim.workspace.applies, 0);
});

test("apply conflict through closeout is FAILED APPLY_CONFLICT, not DONE", async () => {
  const sim = createSimulator("wr022-conflict");
  sim.workspace.applyConflicts = ["product.txt"];
  sim.tracker.seed({
    ticketId: "FX-001",
    title: "conflict",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/FX-001.md",
    planClass: "safe-policy",
    verifyCommand: "true",
    landMode: "apply",
    body: "one",
  });
  const controller = await seedWave(sim, "wave-conflict", ["FX-001"], LIMITS);
  await controller.start("wave-conflict");
  await controller.runUntilIdle("wave-conflict");
  const ticket = controller.inspect("wave-conflict").tickets[0];
  assert.equal(ticket?.status, "FAILED");
  assert.match(ticket?.result ?? "", /APPLY_CONFLICT/);
  assert.notEqual(ticket?.status, "DONE");
  assert.equal(sim.workspace.lands, 0);
});

test("drain scripts default WAVE_LAND_MODE=apply when unset", () => {
  const drain = readFileSync("scripts/drain-eligible.sh", "utf8");
  const wave = readFileSync("scripts/run-backlog-wave.sh", "utf8");
  assert.match(drain, /WAVE_LAND_MODE=apply/);
  assert.match(wave, /WAVE_LAND_MODE=apply/);
  assert.match(wave, /WAVE_LAND_MODE:-.*!= "apply"/);
});

test("markdown land / land_mode parse onto FrozenTicket", async () => {
  const root = mkdtempSync(join(tmpdir(), "wr022-md-"));
  mkdirSync(join(root, "issues"), { recursive: true });
  writeFileSync(
    join(root, "issues", "FX-101.md"),
    `---
id: FX-101
title: Land field
status: open
depends_on: []
verify: "true"
land: apply
---
# FX-101
`,
    "utf8",
  );
  const tracker = new MarkdownTracker(root);
  const tickets = await tracker.snapshot({ ticketIds: ["FX-101"], repoPath: root });
  assert.equal(tickets[0]?.landMode, "apply");
});

test("drain table says applied, not landed, for apply closeout", () => {
  const row = outcomeFromTicket({ ticketId: "A", status: "DONE", result: "verified+applied" });
  assert.equal(row.landOk, true);
  assert.equal(closeoutLabel(row), "applied");
  assert.match(formatDrainTable([row]), /A DONE applied/);
  assert.doesNotMatch(formatDrainTable([row]), /landed/);
});
