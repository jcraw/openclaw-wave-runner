import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { executeLandToMain, git } from "../src/adapters/land-git.js";
import { selectEligibleTickets } from "../src/adapters/eligible-select.js";
import { drainExitCode, formatDrainTable, outcomeFromTicket } from "../src/core/drain-summary.js";
import { landRecoveryReceipt } from "../src/core/land-recovery.js";
import { DEFAULT_LIMITS } from "../src/domain/types.js";
import { scopePaths } from "../src/domain/scope-paths.js";
import { createSimulator, seedWave } from "../src/sim/simulator.js";

const LIMITS = { ...DEFAULT_LIMITS, maxLaunches: 8, maxRetriesPerStage: 0 };

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wave-wr021-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "wave@example.test"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Wave Runner"], { cwd: dir });
  mkdirSync(join(dir, "issues"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "fixture\n", "utf8");
  writeFileSync(join(dir, "product.txt"), "base\n", "utf8");
  writeFileSync(
    join(dir, "issues", "FX-101-one.md"),
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
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

function ticketMd(dir: string, id: string, extra: string): void {
  mkdirSync(join(dir, "issues", "jam"), { recursive: true });
  writeFileSync(
    join(dir, "issues", "jam", `${id}.md`),
    `---
id: ${id}
title: ${id}
status: open
agent_eligible: true
eligibility: agent_eligible
depends_on: []
${extra}
---
# ${id}
`,
    "utf8",
  );
}

test("scopePaths: game/board prefixes; BOARD.md only via sourcePath", () => {
  assert.deepEqual(scopePaths("game:remote_root", "issues/remote_root/RRT-028.md"), [
    "game/jams/remote_root/",
  ]);
  assert.ok(!scopePaths("game:remote_root", "issues/remote_root/RRT-028.md").includes("issues/BOARD.md"));
  assert.deepEqual(scopePaths("board:rink_rush", "issues/rink_rush/RR-073.md"), ["issues/rink_rush/"]);
  assert.deepEqual(scopePaths("prefix:WR", "issues/BOARD.md"), ["issues/BOARD.md"]);
});

test("recovery receipt: overlap writes operator actions; HEAD unchanged", async () => {
  const repo = initRepo();
  const ws = new (await import("../src/adapters/workspace.js")).GitWorkspace();
  const created = await ws.createImplWorktree({
    repoPath: repo,
    baseSha: git(repo, ["rev-parse", "HEAD"]),
    waveId: "w1",
    ticketId: "FX-101",
    worktreeRoot: join(repo, "tmp", "worktrees"),
  });
  writeFileSync(join(created.worktree, "product.txt"), "from-wt\n", "utf8");
  writeFileSync(join(repo, "product.txt"), "primary dirty\n", "utf8");
  const before = git(repo, ["rev-parse", "HEAD"]);
  const bad = await executeLandToMain({
    repoPath: repo,
    worktree: created.worktree,
    ticketId: "FX-101",
    waveId: "w1",
    baseSha: before,
  });
  assert.equal(bad.ok, false);
  assert.match(bad.error ?? "", /overlaps/);
  assert.ok(bad.recovery);
  assert.ok(bad.recovery.overlap.includes("product.txt"));
  assert.match(bad.recovery.operator.join(" "), /stash-unrelated/);
  assert.match(bad.recovery.operator.join(" "), /rebase|land-retry/);
  const proof = JSON.parse(readFileSync(bad.proof, "utf8")) as { recovery?: { overlap?: string[] } };
  assert.ok(proof.recovery?.overlap?.includes("product.txt"));
  assert.equal(git(repo, ["rev-parse", "HEAD"]), before);
});

test("CLOSEOUT_DEBT: verify green + land overlap → FAILED, not DONE", async () => {
  const sim = createSimulator("wr021-debt");
  sim.tracker.seed({
    ticketId: "FX-001",
    title: "debt",
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
    const recovery = landRecoveryReceipt({
      overlap: ["product.txt"],
      dirty: ["product.txt"],
      incoming: ["product.txt"],
      worktree: input.worktree,
      tip: "tip",
    });
    const failed = {
      ok: false as const,
      proof: result.proof,
      error: "primary dirty overlaps land: product.txt",
      recovery,
    };
    writeFileSync(result.proof, JSON.stringify(failed), "utf8");
    return failed;
  };
  const controller = await seedWave(sim, "wave-debt", ["FX-001"], LIMITS);
  await controller.start("wave-debt");
  await controller.runUntilIdle("wave-debt");
  const ticket = controller.inspect("wave-debt").tickets[0];
  assert.equal(ticket?.status, "FAILED");
  assert.match(ticket?.result ?? "", /CLOSEOUT_DEBT/);
  assert.notEqual(ticket?.status, "DONE");
  assert.ok(controller.inspect("wave-debt").artifacts.some((a) => a.kind === "land-recovery"));
});

test("pre-IMPL: dirty jam path + game scope → no launch", async () => {
  const sim = createSimulator("wr021-pre");
  sim.workspace.dirtyPaths = ["game/jams/rink_rush/Player.gd"];
  sim.tracker.seed({
    ticketId: "FX-001",
    title: "pre",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/rink_rush/FX-001.md",
    planClass: "safe-policy",
    verifyCommand: "true",
    writerScope: "game:rink_rush",
    body: "one",
  });
  const controller = await seedWave(sim, "wave-pre", ["FX-001"], LIMITS);
  await controller.start("wave-pre");
  await controller.runUntilIdle("wave-pre");
  const view = controller.inspect("wave-pre");
  assert.equal(view.tickets[0]?.status, "FAILED");
  assert.match(view.tickets[0]?.result ?? "", /primary_dirty_overlap/);
  assert.equal(sim.workspace.lands, 0);
  assert.ok(!view.outbox.some((o) => o.stage === "IMPL"));
});

test("allow-env launches; BOARD.md only does not pre-fail jam scope", async () => {
  const prev = process.env.WAVE_PRIMARY_DIRTY;
  process.env.WAVE_PRIMARY_DIRTY = "allow";
  try {
    const sim = createSimulator("wr021-allow");
    sim.workspace.dirtyPaths = ["game/jams/rink_rush/Player.gd"];
    sim.tracker.seed({
      ticketId: "FX-001",
      title: "allow",
      contentHash: "",
      dependsOn: [],
      order: 1,
      sourcePath: "issues/rink_rush/FX-001.md",
      planClass: "safe-policy",
      verifyCommand: "true",
      writerScope: "game:rink_rush",
      body: "one",
    });
    const controller = await seedWave(sim, "wave-allow", ["FX-001"], LIMITS);
    await controller.start("wave-allow");
    await controller.runUntilIdle("wave-allow");
    assert.equal(controller.inspect("wave-allow").tickets[0]?.status, "DONE");
  } finally {
    if (prev === undefined) delete process.env.WAVE_PRIMARY_DIRTY;
    else process.env.WAVE_PRIMARY_DIRTY = prev;
  }

  const board = createSimulator("wr021-board");
  board.workspace.dirtyPaths = ["issues/BOARD.md"];
  board.tracker.seed({
    ticketId: "FX-001",
    title: "board",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/rink_rush/FX-001.md",
    planClass: "safe-policy",
    verifyCommand: "true",
    writerScope: "game:rink_rush",
    body: "one",
  });
  const ctrl = await seedWave(board, "wave-board", ["FX-001"], LIMITS);
  await ctrl.start("wave-board");
  await ctrl.runUntilIdle("wave-board");
  assert.equal(ctrl.inspect("wave-board").tickets[0]?.status, "DONE");
});

test("dry-run warning: primary_dirty_overlap; create still ok", async () => {
  const sim = createSimulator("wr021-dry");
  sim.workspace.dirtyPaths = ["game/jams/rink_rush/Player.gd"];
  sim.tracker.seed({
    ticketId: "FX-001",
    title: "dry",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/rink_rush/FX-001.md",
    planClass: "safe-policy",
    verifyCommand: "true",
    writerScope: "game:rink_rush",
    body: "one",
  });
  const controller = sim.open();
  const preview = await controller.dryRun({
    waveId: "wave-dry",
    repoPath: "/tmp/wave-fixture-repo",
    ticketIds: ["FX-001"],
    limits: LIMITS,
  });
  assert.equal(preview.ok, true);
  assert.ok(preview.admitBlockers.some((b) => b.code === "primary_dirty_overlap" && b.ticketId === "FX-001"));
  const created = await controller.create({
    waveId: "wave-dry",
    repoPath: "/tmp/wave-fixture-repo",
    ticketIds: ["FX-001"],
    limits: LIMITS,
  });
  assert.equal(created.tickets.length, 1);
});

test("select skip: empty verify not enqueued; reason names ticket id", () => {
  const root = mkdtempSync(join(tmpdir(), "wr021-select-"));
  ticketMd(root, "RRT-028", `verify: "test -s NOTE.md"`);
  ticketMd(root, "RRT-029", `verify_command: ""`);
  const result = selectEligibleTickets(root);
  assert.ok(result.eligible.includes("RRT-028"));
  assert.ok(!result.eligible.includes("RRT-029"));
  const skip = result.skipped.find((s) => s.ticketId === "RRT-029");
  assert.ok(skip);
  assert.match(skip.reason, /missing_verify/);
  assert.match(skip.reason, /RRT-029/);
});

test("drain exit: FAILED → 1; best-effort → 0 + table", () => {
  const rows = [
    outcomeFromTicket({ ticketId: "A", status: "DONE", result: "verified+landed abc" }),
    outcomeFromTicket({
      ticketId: "B",
      status: "FAILED",
      result: "CLOSEOUT_DEBT: land failed: primary dirty overlaps land: x",
    }),
  ];
  assert.equal(rows[1]?.outcome, "CLOSEOUT_DEBT");
  assert.equal(drainExitCode(rows, false), 1);
  assert.equal(drainExitCode(rows, true), 0);
  assert.equal(drainExitCode([rows[0]!], false), 0);
  assert.match(formatDrainTable(rows), /B CLOSEOUT_DEBT/);
});
