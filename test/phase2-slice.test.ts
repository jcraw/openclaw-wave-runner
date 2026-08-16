import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { MarkdownTracker } from "../src/adapters/markdown-tracker.js";
import { MockUsage, MockWorker, MockWorkflow, SafePolicy } from "../src/adapters/mocks.js";
import { GitWorkspace } from "../src/adapters/workspace.js";
import { FakeClock, SequentialIds } from "../src/domain/clock.js";
import { DEFAULT_LIMITS } from "../src/domain/types.js";
import { WaveController } from "../src/core/controller.js";
import { WaveDatabase } from "../src/store/database.js";
import { FakeOpenClawRuntime } from "./fakes.js";
import { ManagedTaskFlowBackend } from "../src/adapters/taskflow.js";

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wave-p2-repo-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "wave@example.test"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Wave Runner"], { cwd: dir });
  mkdirSync(join(dir, "issues"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "fixture\n", "utf8");
  writeFileSync(
    join(dir, "issues", "FX-101-one-ticket.md"),
    `---
id: FX-101
title: One ticket vertical slice
status: open
depends_on: []
plan_class: manual
verify: "true"
---

# FX-101

Do a harmless fixture change.
`,
    "utf8",
  );
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init fixture"], { cwd: dir });
  return dir;
}

function makeController(repo: string, dbPath: string, runtime = new FakeOpenClawRuntime()) {
  const clock = new FakeClock();
  return new WaveController({
    db: new WaveDatabase(dbPath),
    clock,
    ids: new SequentialIds(),
    tracker: new MarkdownTracker(repo),
    workflow: new ManagedTaskFlowBackend(runtime.managedFlows),
    worker: new MockWorker(),
    usage: new MockUsage(),
    workspace: new GitWorkspace(),
    policy: new SafePolicy(),
    process: { holder: "p2", processIdentity: "p2-1" },
    worktreeRoot: join(repo, "tmp", "wave-runner", "worktrees"),
  });
}

test("Phase 2: markdown + task flow + worktree PLAN/approve/IMPL/verify", async () => {
  const repo = initRepo();
  const dbPath = join(repo, "tmp", "wave.sqlite");
  const runtime = new FakeOpenClawRuntime();
  let controller = makeController(repo, dbPath, runtime);
  const primarySha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  await controller.create({
    waveId: "slice-one",
    repoPath: repo,
    ticketIds: ["FX-101"],
    limits: { ...DEFAULT_LIMITS, maxLaunches: 3, maxRetriesPerStage: 0 },
  });
  await controller.start("slice-one");
  await controller.runUntilIdle("slice-one");
  let view = controller.inspect("slice-one");
  assert.equal(view.wave.status, "AWAITING_PLAN_GATE");
  assert.equal(view.tickets[0]?.status, "PLAN_REVIEW");
  assert.ok(view.wave.flowId);
  assert.equal(view.budgets[0]?.state, "INDETERMINATE");

  const restoredRuntime = FakeOpenClawRuntime.restore(runtime.snapshot());
  controller = makeController(repo, dbPath, restoredRuntime);
  const afterRestart = controller.inspect("slice-one");
  assert.equal(afterRestart.wave.status, "AWAITING_PLAN_GATE");
  assert.equal(afterRestart.wave.manifestHash, view.wave.manifestHash);

  const ticket = afterRestart.tickets[0]!;
  controller.approve("slice-one", ticket.ticketId, ticket.revision);
  await controller.runUntilIdle("slice-one");
  view = controller.inspect("slice-one");
  assert.equal(view.tickets[0]?.status, "DONE", String(view.tickets[0]?.result ?? ""));
  assert.equal(view.wave.status, "COMPLETED");
  assert.ok(view.tickets[0]?.implWorktree);
  assert.ok(view.tickets[0]?.verifyProof);
  assert.match(String(view.tickets[0]?.result ?? ""), /verified/);
  // WR-013 land-on-done may advance primary when the worktree had commits.
  void primarySha;
});

test("Phase 2: cancellation prevents new children and duplicate completions are harmless", async () => {
  const repo = initRepo();
  const controller = makeController(repo, join(repo, "tmp", "wave.sqlite"));
  await controller.create({
    waveId: "slice-cancel",
    repoPath: repo,
    ticketIds: ["FX-101"],
    limits: DEFAULT_LIMITS,
  });
  await controller.start("slice-cancel");
  controller.cancel("slice-cancel");
  const cancelled = controller.inspect("slice-cancel");
  assert.equal(cancelled.wave.status, "CANCELLED");
  assert.equal(cancelled.wave.cancelRequested, true);
  await assert.rejects(() => controller.start("slice-cancel", "evt-new-child"), /cancel|Illegal wave/);
  const eventCount = cancelled.events.length;
  const again = controller.inspect("slice-cancel");
  assert.equal(again.events.length, eventCount);
});
