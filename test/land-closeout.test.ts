import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveLandIdentity } from "../src/adapters/land-identity.js";
import { executeLandToMain, formatGitError, git } from "../src/adapters/land-git.js";
import { GitWorkspace } from "../src/adapters/workspace.js";
import { finalizeImplLand, shouldLandPush } from "../src/core/land-closeout.js";
import { advancePendingCloseouts } from "../src/core/pending-closeout.js";
import type { LaunchOutbox, LeaseRecord } from "../src/domain/types.js";
import { deriveWriterScope, landLockKey, writerLeaseKey } from "../src/domain/writer-scope.js";
import { createSimulator, seedWave } from "../src/sim/simulator.js";

function initRepo(extra?: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "wave-wr017-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "wave@example.test"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Wave Runner"], { cwd: dir });
  mkdirSync(join(dir, "issues"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "fixture\n", "utf8");
  writeFileSync(join(dir, "product.txt"), "base\n", "utf8");
  writeFileSync(
    join(dir, "issues", "FX-101-one-ticket.md"),
    `---
id: FX-101
title: Land fixture
status: open
depends_on: []
verify: "true"
---

# FX-101
`,
    "utf8",
  );
  writeFileSync(join(dir, "issues", "BOARD.md"), "- **FX-101 open** fixture\n", "utf8");
  extra?.(dir);
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init fixture"], { cwd: dir });
  return dir;
}

async function makeTree(repo: string, waveId = "w1", ticketId = "FX-101") {
  const ws = new GitWorkspace();
  const created = await ws.createImplWorktree({
    repoPath: repo,
    baseSha: git(repo, ["rev-parse", "HEAD"]),
    waveId,
    ticketId,
    worktreeRoot: join(repo, "tmp", "worktrees"),
  });
  return { ws, ...created };
}

function landInput(
  repo: string,
  worktree: string,
  over: Partial<Parameters<typeof executeLandToMain>[0]> = {},
) {
  return {
    repoPath: repo,
    worktree,
    ticketId: "FX-101",
    waveId: "w1",
    baseSha: git(repo, ["rev-parse", "HEAD"]),
    ...over,
  };
}

function emails(repo: string): string {
  return execFileSync("git", ["-C", repo, "log", "--format=%ae"], { encoding: "utf8" });
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

test("resolveLandIdentity: env, missing, personal mailbox", () => {
  assert.deepEqual(
    resolveLandIdentity({
      repoPath: "/tmp/x",
      env: { WAVE_LAND_NAME: "Bot", WAVE_LAND_EMAIL: "wave@example.test" },
    }),
    { ok: true, identity: { name: "Bot", email: "wave@example.test" } },
  );
  assert.equal(
    resolveLandIdentity({
      repoPath: "/tmp/x",
      env: { WAVE_LAND_NAME: "Bot" },
      readConfig: () => "",
    }).ok,
    false,
  );
  const personal = resolveLandIdentity({
    repoPath: "/tmp/x",
    env: { WAVE_LAND_NAME: "N", WAVE_LAND_EMAIL: "n@gmail.com" },
  });
  assert.equal(personal.ok, false);
  assert.match(personal.ok ? "" : personal.error, /personal mailbox/);
  assert.match(formatGitError({ message: "Command failed", stderr: "fatal: boom" }), /fatal: boom/);
  assert.equal(shouldLandPush({}), false);
  assert.equal(shouldLandPush({ WAVE_LAND_PUSH: "1" }), true);
});

test("no invented author; durable proof; worktree gone", async () => {
  const repo = initRepo();
  const { ws, worktree } = await makeTree(repo);
  writeFileSync(join(worktree, "product.txt"), "from-wt\n", "utf8");
  const land = await ws.landToMain(landInput(repo, worktree));
  assert.equal(land.ok, true, land.error);
  assert.notEqual(git(repo, ["log", "-1", "--format=%ae"]), "wave-runner@local");
  assert.equal(git(repo, ["log", "-1", "--format=%ae"]), "wave@example.test");
  assert.doesNotMatch(emails(repo), /wave-runner@local/);
  assert.equal(readFileSync(join(repo, "product.txt"), "utf8"), "from-wt\n");
  const proof = join(repo, "tmp", "wave-runner", "w1", "FX-101", "LAND.json");
  assert.equal(land.proof, proof);
  assert.equal(existsSync(proof), true);
  const body = JSON.parse(readFileSync(proof, "utf8")) as { ok?: boolean; commitSha?: string; note?: string };
  assert.equal(body.ok, true);
  assert.ok(body.commitSha);
  assert.notEqual(body.note, "already-on-primary");
  const listed = execFileSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf8" });
  assert.ok(!listed.includes(worktree));
});

test("merge identity uses repo email on non-ff land", async () => {
  const repo = initRepo();
  const { worktree, branch } = await makeTree(repo);
  writeFileSync(join(worktree, "product.txt"), "from-wt\n", "utf8");
  writeFileSync(join(repo, "other.txt"), "primary\n", "utf8");
  execFileSync("git", ["add", "other.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "primary moves"], { cwd: repo });
  const land = await executeLandToMain(landInput(repo, worktree, { branch }));
  assert.equal(land.ok, true, land.error);
  const mergeSha = git(repo, ["rev-list", "--merges", "-n", "1", "HEAD"]);
  assert.ok(mergeSha, "expected a merge commit");
  const parents = git(repo, ["log", "-1", "--format=%P", mergeSha]).split(" ").filter(Boolean);
  assert.ok(parents.length >= 2, "expected a merge commit");
  assert.equal(git(repo, ["log", "-1", "--format=%ae", mergeSha]), "wave@example.test");
});

test("unrelated dirt survives; overlapping dirt fails closed", async () => {
  const repo = initRepo();
  const { worktree } = await makeTree(repo);
  writeFileSync(join(worktree, "product.txt"), "from-wt\n", "utf8");
  writeFileSync(join(repo, "dirt.txt"), "unrelated\n", "utf8");
  const okLand = await executeLandToMain(landInput(repo, worktree));
  assert.equal(okLand.ok, true, okLand.error);
  assert.equal(existsSync(join(repo, "dirt.txt")), true);
  assert.equal(readFileSync(join(repo, "product.txt"), "utf8"), "from-wt\n");

  const repo2 = initRepo();
  const second = await makeTree(repo2);
  writeFileSync(join(second.worktree, "product.txt"), "from-wt\n", "utf8");
  writeFileSync(join(repo2, "product.txt"), "primary dirty\n", "utf8");
  const before = git(repo2, ["rev-parse", "HEAD"]);
  const bad = await executeLandToMain(landInput(repo2, second.worktree));
  assert.equal(bad.ok, false);
  assert.match(bad.error ?? "", /overlaps/);
  assert.equal(git(repo2, ["rev-parse", "HEAD"]), before);
});

test("failed land keeps worktree; push fail records sha", async () => {
  const repo = initRepo();
  const { worktree } = await makeTree(repo);
  writeFileSync(join(worktree, "product.txt"), "from-wt\n", "utf8");
  writeFileSync(join(repo, "product.txt"), "primary\n", "utf8");
  execFileSync("git", ["add", "product.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "primary conflict"], { cwd: repo });
  const failed = await executeLandToMain(landInput(repo, worktree));
  assert.equal(failed.ok, false);
  assert.match(failed.error ?? "", /merge failed/);
  const listed = execFileSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf8" });
  assert.ok(listed.includes(worktree));

  const pushRepo = initRepo();
  const pushTree = await makeTree(pushRepo, "w1", "FX-101");
  writeFileSync(join(pushTree.worktree, "product.txt"), "from-wt\n", "utf8");
  execFileSync("git", ["remote", "add", "origin", join(pushRepo, "no-such-remote.git")], {
    cwd: pushRepo,
  });
  const pushed = await executeLandToMain(landInput(pushRepo, pushTree.worktree, { push: true }));
  assert.equal(pushed.ok, false);
  assert.match(pushed.error ?? "", /push failed/);
  assert.ok(pushed.commitSha);
  const proof = JSON.parse(
    readFileSync(join(pushRepo, "tmp", "wave-runner", "w1", "FX-101", "LAND.json"), "utf8"),
  ) as { commitSha?: string; error?: string };
  assert.ok(proof.commitSha);
  assert.match(proof.error ?? "", /push failed/);
});

test("ancestor retry does not create a second merge", async () => {
  const repo = initRepo();
  const { worktree, branch } = await makeTree(repo);
  writeFileSync(join(worktree, "product.txt"), "from-wt\n", "utf8");
  writeFileSync(join(repo, "other.txt"), "primary\n", "utf8");
  execFileSync("git", ["add", "other.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "primary moves"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", join(repo, "no-such-remote.git")], { cwd: repo });
  const first = await executeLandToMain(landInput(repo, worktree, { branch, push: true }));
  assert.equal(first.ok, false);
  assert.match(first.error ?? "", /push failed/);
  const merges = git(repo, ["rev-list", "--merges", "--count", "HEAD"]);
  const second = await executeLandToMain(landInput(repo, worktree, { branch, push: false }));
  assert.equal(second.ok, true, second.error);
  assert.equal(git(repo, ["rev-list", "--merges", "--count", "HEAD"]), merges);
});

test("personal mailbox refuses land; env identity wins", async () => {
  const repo = initRepo();
  execFileSync("git", ["config", "user.email", "person@gmail.com"], { cwd: repo });
  const { worktree } = await makeTree(repo);
  writeFileSync(join(worktree, "product.txt"), "from-wt\n", "utf8");
  const denied = await executeLandToMain(landInput(repo, worktree));
  assert.equal(denied.ok, false);
  assert.match(denied.error ?? "", /personal mailbox/);
  const prevName = process.env.WAVE_LAND_NAME;
  const prevEmail = process.env.WAVE_LAND_EMAIL;
  process.env.WAVE_LAND_NAME = "Env Land";
  process.env.WAVE_LAND_EMAIL = "wave@example.test";
  try {
    const allowed = await executeLandToMain(landInput(repo, worktree));
    assert.equal(allowed.ok, true, allowed.error);
    assert.equal(git(repo, ["log", "-1", "--format=%ae"]), "wave@example.test");
  } finally {
    if (prevName === undefined) delete process.env.WAVE_LAND_NAME;
    else process.env.WAVE_LAND_NAME = prevName;
    if (prevEmail === undefined) delete process.env.WAVE_LAND_EMAIL;
    else process.env.WAVE_LAND_EMAIL = prevEmail;
  }
});

test("tmp noise is not committed; off-main dirty fails", async () => {
  const repo = initRepo();
  const { worktree } = await makeTree(repo);
  mkdirSync(join(worktree, "tmp", "wave-runs"), { recursive: true });
  writeFileSync(join(worktree, "tmp", "wave-runs", "noise.txt"), "nope\n", "utf8");
  writeFileSync(join(worktree, "product.txt"), "from-wt\n", "utf8");
  const land = await executeLandToMain(landInput(repo, worktree));
  assert.equal(land.ok, true, land.error);
  const names = git(repo, ["ls-tree", "-r", "--name-only", "HEAD"]);
  assert.doesNotMatch(names, /wave-runs\/noise/);

  const repo2 = initRepo();
  const tree2 = await makeTree(repo2);
  writeFileSync(join(tree2.worktree, "product.txt"), "from-wt\n", "utf8");
  execFileSync("git", ["checkout", "-b", "other"], { cwd: repo2 });
  writeFileSync(join(repo2, "stuck.txt"), "dirty\n", "utf8");
  const bad = await executeLandToMain(landInput(repo2, tree2.worktree));
  assert.equal(bad.ok, false);
  assert.match(bad.error ?? "", /not on main and dirty/);
});

test("DONE needs proof; missing landToMain / worktree fail closed", async () => {
  const sim = createSimulator("wr017-done");
  sim.tracker.seed({
    ticketId: "FX-001",
    title: "land",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/FX-001.md",
    planClass: "safe-policy",
    verifyCommand: "true",
    body: "one",
  });
  const controller = await seedWave(sim, "wave-done", ["FX-001"]);
  await controller.start("wave-done");
  await controller.runUntilIdle("wave-done");
  const view = controller.inspect("wave-done");
  assert.equal(view.tickets[0]?.status, "DONE");
  assert.match(String(view.tickets[0]?.result ?? ""), /verified\+landed/);
  const wt = view.tickets[0]?.implWorktree;
  assert.ok(wt);
  assert.equal(existsSync(join(wt, "LAND.json")), true);

  const noLand = createSimulator("wr017-noland");
  (noLand.workspace as { landToMain?: unknown }).landToMain = undefined;
  noLand.tracker.seed({
    ticketId: "FX-001",
    title: "noland",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/FX-001.md",
    planClass: "safe-policy",
    verifyCommand: "true",
    body: "one",
  });
  const ctrl2 = await seedWave(noLand, "wave-noland", ["FX-001"]);
  await ctrl2.start("wave-noland");
  await ctrl2.runUntilIdle("wave-noland");
  assert.equal(ctrl2.inspect("wave-noland").tickets[0]?.status, "FAILED");
  assert.match(ctrl2.inspect("wave-noland").tickets[0]?.result ?? "", /land failed/);

  const missing = createSimulator("wr017-misswt");
  missing.tracker.seed({
    ticketId: "FX-001",
    title: "miss",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/FX-001.md",
    planClass: "safe-policy",
    verifyCommand: "true",
    body: "one",
  });
  const ctrl3 = await seedWave(missing, "wave-miss", ["FX-001"]);
  const ticket = ctrl3.inspect("wave-miss").tickets[0]!;
  ctrl3.db.putTicket({ ...ticket, status: "VERIFYING", implWorktree: undefined });
  await finalizeImplLand(ctrl3, outbox("wave-miss", "FX-001"));
  assert.equal(ctrl3.inspect("wave-miss").tickets[0]?.status, "FAILED");
  assert.match(ctrl3.inspect("wave-miss").tickets[0]?.result ?? "", /missing impl worktree/);
});

test("lease is held through land; land lock serializes", async () => {
  const sim = createSimulator("wr017-lease");
  sim.tracker.seed({
    ticketId: "FX-001",
    title: "lease",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/FX-001.md",
    planClass: "safe-policy",
    verifyCommand: "true",
    body: "one",
  });
  const controller = await seedWave(sim, "wave-lease", ["FX-001"]);
  const orig = controller.workspace.landToMain!.bind(controller.workspace);
  let seen: LeaseRecord | undefined;
  controller.workspace.landToMain = async (input) => {
    const live = controller.inspect("wave-lease").tickets[0]!;
    const scope = live.writerScope || deriveWriterScope(live);
    seen = controller.db.getLease(writerLeaseKey("/tmp/wave-fixture-repo", scope));
    return orig(input);
  };
  await controller.start("wave-lease");
  await controller.runUntilIdle("wave-lease");
  assert.ok(seen, "writer lease should be present during land");
  assert.equal(controller.inspect("wave-lease").tickets[0]?.status, "DONE");

  const lockSim = createSimulator("wr017-lock");
  lockSim.tracker.seed({
    ticketId: "FX-001",
    title: "one",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/FX-001.md",
    planClass: "safe-policy",
    verifyCommand: "true",
    body: "one",
  });
  lockSim.tracker.seed({
    ticketId: "FX-002",
    title: "two",
    contentHash: "",
    dependsOn: [],
    order: 2,
    sourcePath: "issues/FX-002.md",
    planClass: "safe-policy",
    verifyCommand: "true",
    body: "two",
  });
  const lockCtrl = await seedWave(lockSim, "wave-lock", ["FX-001", "FX-002"]);
  const root = join(tmpdir(), "wr017-lock-trees");
  for (const id of ["FX-001", "FX-002"]) {
    const path = join(root, id);
    mkdirSync(path, { recursive: true });
    const t = lockCtrl.db.getTicket("wave-lock", id)!;
    lockCtrl.db.putTicket({ ...t, status: "VERIFYING", implWorktree: path });
  }
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const landOrig = lockCtrl.workspace.landToMain!.bind(lockCtrl.workspace);
  let inLand = 0;
  let maxInLand = 0;
  lockCtrl.workspace.landToMain = async (input) => {
    inLand += 1;
    maxInLand = Math.max(maxInLand, inLand);
    try {
      if (input.ticketId === "FX-001") await gate;
      return landOrig(input);
    } finally {
      inLand -= 1;
    }
  };
  const p1 = finalizeImplLand(lockCtrl, outbox("wave-lock", "FX-001"));
  await Promise.resolve();
  assert.ok(lockCtrl.db.getLease(landLockKey("/tmp/wave-fixture-repo")));
  await finalizeImplLand(lockCtrl, outbox("wave-lock", "FX-002"));
  assert.equal(lockCtrl.db.getTicket("wave-lock", "FX-002")?.status, "VERIFYING");
  release();
  await p1;
  assert.equal(lockCtrl.db.getTicket("wave-lock", "FX-001")?.status, "DONE");
  await lockCtrl.tick("wave-lock");
  assert.equal(lockCtrl.db.getTicket("wave-lock", "FX-002")?.status, "DONE");
  assert.equal(maxInLand, 1);
});

test("push fail through closeout does not DONE; mock still writes worktree LAND.json", async () => {
  const sim = createSimulator("wr017-push");
  sim.tracker.seed({
    ticketId: "FX-001",
    title: "push",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/FX-001.md",
    planClass: "safe-policy",
    verifyCommand: "true",
    body: "one",
  });
  const orig = sim.workspace.landToMain.bind(sim.workspace);
  sim.workspace.landToMain = async (input) => {
    const result = await orig(input);
    const proof = join(input.worktree, "LAND.json");
    const failed = { ok: false as const, commitSha: "deadbeef", proof, error: "push failed: origin refused" };
    writeFileSync(proof, JSON.stringify(failed), "utf8");
    return failed;
  };
  const controller = await seedWave(sim, "wave-push", ["FX-001"]);
  await controller.start("wave-push");
  await controller.runUntilIdle("wave-push");
  const ticket = controller.inspect("wave-push").tickets[0];
  assert.notEqual(ticket?.status, "DONE");
  assert.match(ticket?.result ?? "", /push failed/);
  const land = JSON.parse(readFileSync(join(ticket!.implWorktree!, "LAND.json"), "utf8")) as {
    commitSha?: string;
    error?: string;
  };
  assert.equal(land.commitSha, "deadbeef");
  assert.match(land.error ?? "", /push failed/);
});

test("already-on-primary still writes LAND.json and drops the worktree", async () => {
  const repo = initRepo();
  const { worktree } = await makeTree(repo);
  const land = await executeLandToMain(landInput(repo, worktree));
  assert.equal(land.ok, true, land.error);
  const proof = JSON.parse(
    readFileSync(join(repo, "tmp", "wave-runner", "w1", "FX-101", "LAND.json"), "utf8"),
  ) as { ok?: boolean; note?: string; commitSha?: string };
  assert.equal(proof.ok, true);
  assert.equal(proof.note, "already-on-primary");
  assert.ok(proof.commitSha);
  const listed = execFileSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf8" });
  assert.ok(!listed.includes(worktree));
});
