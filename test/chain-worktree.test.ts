import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { git } from "../src/adapters/land-git.js";
import { GitWorkspace } from "../src/adapters/workspace.js";
import { predecessorImplSha } from "../src/core/chain-worktree.js";
import { createSimulator, seedWave } from "../src/sim/simulator.js";

function peer(
  ticketId: string,
  status: string,
  order: number,
  implSha?: string,
): { ticketId: string; status: string; order: number; implSha?: string } {
  return { ticketId, status, order, implSha };
}

test("predecessorImplSha: missing or incomplete deps yield undefined", () => {
  assert.equal(predecessorImplSha({ dependsOn: [] }, [peer("A", "DONE", 1, "sha-a")]), undefined);
  assert.equal(
    predecessorImplSha({ dependsOn: ["A"] }, [peer("A", "APPROVED", 1, "sha-a")]),
    undefined,
  );
  assert.equal(predecessorImplSha({ dependsOn: ["A"] }, [peer("A", "DONE", 1)]), undefined);
  assert.equal(predecessorImplSha({ dependsOn: ["Z"] }, [peer("A", "DONE", 1, "sha-a")]), undefined);
});

test("predecessorImplSha: highest order DONE dep wins", () => {
  assert.equal(
    predecessorImplSha({ dependsOn: ["A"] }, [peer("A", "DONE", 1, "sha-a")]),
    "sha-a",
  );
  assert.equal(
    predecessorImplSha(
      { dependsOn: ["A", "B"] },
      [peer("A", "DONE", 3, "sha-a"), peer("B", "DONE", 2, "sha-b")],
    ),
    "sha-a",
  );
  assert.equal(
    predecessorImplSha(
      { dependsOn: ["B", "A"] },
      [peer("A", "DONE", 3, "sha-a"), peer("B", "DONE", 2, "sha-b")],
    ),
    "sha-a",
  );
  assert.equal(
    predecessorImplSha(
      { dependsOn: ["A", "B"] },
      [peer("A", "FAILED", 3, "sha-a"), peer("B", "DONE", 2, "sha-b")],
    ),
    "sha-b",
  );
});

test("mock chain: successor worktree uses predecessor implSha", async () => {
  const sim = createSimulator("wr006-chain");
  const controller = await seedWave(sim, "wave-chain", ["FX-001", "FX-002"], {
    maxTokens: 80_000,
    maxLaunches: 12,
    perStageReservationTokens: 8_000,
  });
  await controller.start("wave-chain");
  await controller.runUntilIdle("wave-chain");
  const first = controller.inspect("wave-chain").tickets.find((t) => t.ticketId === "FX-001")!;
  controller.approve("wave-chain", first.ticketId, first.revision);
  await controller.runUntilIdle("wave-chain");
  const view = controller.inspect("wave-chain");
  const a = view.tickets.find((t) => t.ticketId === "FX-001")!;
  const b = view.tickets.find((t) => t.ticketId === "FX-002")!;
  assert.equal(a.status, "DONE");
  assert.ok(a.implSha);
  assert.ok(sim.workspace.commits >= 1);
  assert.ok(b.implWorktree);
  const recorded = readFileSync(join(b.implWorktree!, "WORKTREE"), "utf8").trim();
  assert.equal(recorded, a.implSha);
  assert.notEqual(recorded, view.wave.baseSha);
});

test("verify-fail does not commit or set implSha", async () => {
  const sim = createSimulator("wr006-fail");
  sim.tracker.seed({
    ticketId: "FX-001",
    title: "Fixture one",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/FX-001.md",
    planClass: "manual",
    verifyCommand: "false",
    body: "one",
  });
  const controller = await seedWave(sim, "wave-fail", ["FX-001"], { maxRetriesPerStage: 0 });
  await controller.start("wave-fail");
  await controller.runUntilIdle("wave-fail");
  const first = controller.inspect("wave-fail").tickets.find((t) => t.ticketId === "FX-001")!;
  controller.approve("wave-fail", first.ticketId, first.revision);
  await controller.runUntilIdle("wave-fail");
  const t = controller.inspect("wave-fail").tickets.find((t) => t.ticketId === "FX-001")!;
  assert.equal(sim.workspace.commits, 0);
  assert.equal(t.implSha, undefined);
  assert.notEqual(t.status, "DONE");
});

test("empty commit sha is controller-fail and does not land", async () => {
  const sim = createSimulator("wr006-empty-sha");
  sim.workspace.commitVerifiedWorktree = async () => ({ sha: "  " });
  const controller = await seedWave(sim, "wave-empty", ["FX-001"], { maxRetriesPerStage: 0 });
  await controller.start("wave-empty");
  await controller.runUntilIdle("wave-empty");
  const first = controller.inspect("wave-empty").tickets.find((t) => t.ticketId === "FX-001")!;
  controller.approve("wave-empty", first.ticketId, first.revision);
  await controller.runUntilIdle("wave-empty");
  const t = controller.inspect("wave-empty").tickets.find((t) => t.ticketId === "FX-001")!;
  assert.equal(t.implSha, undefined);
  assert.notEqual(t.status, "DONE");
  assert.equal(sim.workspace.lands, 0);
  assert.match(t.result ?? "", /empty sha/);
});

test("commit throw is controller-fail and does not land", async () => {
  const sim = createSimulator("wr006-commit-fail");
  sim.workspace.commitVerifiedWorktree = async () => {
    throw new Error("land identity missing");
  };
  const controller = await seedWave(sim, "wave-cfail", ["FX-001"], { maxRetriesPerStage: 0 });
  await controller.start("wave-cfail");
  await controller.runUntilIdle("wave-cfail");
  const first = controller.inspect("wave-cfail").tickets.find((t) => t.ticketId === "FX-001")!;
  controller.approve("wave-cfail", first.ticketId, first.revision);
  await controller.runUntilIdle("wave-cfail");
  const t = controller.inspect("wave-cfail").tickets.find((t) => t.ticketId === "FX-001")!;
  assert.equal(t.implSha, undefined);
  assert.notEqual(t.status, "DONE");
  assert.equal(sim.workspace.lands, 0);
  assert.match(t.result ?? "", /commit-on-verify/);
});

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wave-wr006-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "wave@example.test"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Wave Runner"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "fixture\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init fixture"], { cwd: dir });
  return dir;
}

test("git: successor sees predecessor file; primary HEAD unchanged", async () => {
  const repo = initRepo();
  const primaryBefore = git(repo, ["rev-parse", "HEAD"]);
  const ws = new GitWorkspace();
  const a = await ws.createImplWorktree({
    repoPath: repo,
    baseSha: primaryBefore,
    waveId: "w1",
    ticketId: "A",
    worktreeRoot: join(repo, "tmp", "worktrees"),
  });
  writeFileSync(join(a.worktree, "from-a.txt"), "from a\n", "utf8");
  const committed = await ws.commitVerifiedWorktree({
    repoPath: repo,
    worktree: a.worktree,
    ticketId: "A",
    waveId: "w1",
  });
  assert.match(committed.sha, /^[0-9a-f]{40}$/);
  assert.equal(git(repo, ["rev-parse", a.branch]), committed.sha);
  const b = await ws.createImplWorktree({
    repoPath: repo,
    baseSha: committed.sha,
    waveId: "w1",
    ticketId: "B",
    worktreeRoot: join(repo, "tmp", "worktrees"),
  });
  assert.equal(readFileSync(join(b.worktree, "from-a.txt"), "utf8"), "from a\n");
  assert.equal(git(repo, ["rev-parse", "HEAD"]), primaryBefore);
});

test("git: adapter does not commit unless invoked", async () => {
  const repo = initRepo();
  const ws = new GitWorkspace();
  const a = await ws.createImplWorktree({
    repoPath: repo,
    baseSha: git(repo, ["rev-parse", "HEAD"]),
    waveId: "w1",
    ticketId: "A",
    worktreeRoot: join(repo, "tmp", "worktrees"),
  });
  const beforeCount = git(a.worktree, ["rev-list", "--count", "HEAD"]);
  const beforeLog = git(a.worktree, ["log", "-1", "--format=%H"]);
  writeFileSync(join(a.worktree, "dirty.txt"), "no commit\n", "utf8");
  assert.equal(git(a.worktree, ["rev-list", "--count", "HEAD"]), beforeCount);
  assert.equal(git(a.worktree, ["log", "-1", "--format=%H"]), beforeLog);
});
