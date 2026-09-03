import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { applyToWorkdir } from "../src/adapters/apply-workdir.js";
import { git } from "../src/adapters/land-git.js";
import { GitWorkspace } from "../src/adapters/workspace.js";
import { expireStaleLeases } from "../src/core/lease-release.js";
import { MemoryAuthority } from "../src/core/authority.js";
import { WaveController } from "../src/core/controller.js";
import { FakeClock, SequentialIds } from "../src/domain/clock.js";
import { DEFAULT_LIMITS } from "../src/domain/types.js";
import {
  MockTracker,
  MockUsage,
  MockWorker,
  MockWorkflow,
  MockWorkspace,
  SafePolicy,
} from "../src/adapters/mocks.js";
import { createSimulator, seedWave } from "../src/sim/simulator.js";
import { WaveDatabase } from "../src/store/database.js";
import { writerLeaseKey } from "../src/domain/writer-scope.js";

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wave-wr032-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "wave@example.test"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Wave Runner"], { cwd: dir });
  mkdirSync(join(dir, "issues"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "fixture\n", "utf8");
  writeFileSync(
    join(dir, "issues", "FX-201.md"),
    `---
id: FX-201
title: Apply commit
status: open
depends_on: []
verify: "true"
land: apply
---
# FX-201
`,
    "utf8",
  );
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

test("apply commits copied paths so next HEAD is the land SHA", async () => {
  const repo = initRepo();
  const base = git(repo, ["rev-parse", "HEAD"]);
  const ws = new GitWorkspace();
  const created = await ws.createImplWorktree({
    repoPath: repo,
    baseSha: base,
    waveId: "w32",
    ticketId: "FX-201",
    worktreeRoot: join(repo, "tmp", "worktrees"),
  });
  writeFileSync(join(created.worktree, "charge.txt"), "pad\n", "utf8");
  const applied = await applyToWorkdir({
    repoPath: repo,
    worktree: created.worktree,
    ticketId: "FX-201",
    waveId: "w32",
    baseSha: base,
    artifactRoot: join(repo, "tmp", "artifacts"),
  });
  assert.equal(applied.ok, true);
  assert.ok(applied.commitSha);
  assert.notEqual(applied.commitSha, base);
  assert.equal(git(repo, ["rev-parse", "HEAD"]), applied.commitSha);
  assert.equal(readFileSync(join(repo, "charge.txt"), "utf8"), "pad\n");
  assert.match(git(repo, ["log", "-1", "--pretty=%s"]), /Land FX-201 apply closeout/);
});

test("apply-mode missing writer lease still reaches DONE after verify", async () => {
  const sim = createSimulator("wr032-fence");
  sim.tracker.seed({
    ticketId: "AP-032",
    title: "apply fence",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/AP-032.md",
    verifyCommand: "true",
    landMode: "apply",
    body: "apply",
  });
  const controller = await seedWave(sim, "wave-ap", ["AP-032"], {
    ...DEFAULT_LIMITS,
    maxTokens: 80_000,
    maxLaunches: 8,
  });
  await controller.start("wave-ap");
  const key = writerLeaseKey(controller.inspect("wave-ap").wave.repoPath, "repo");
  for (let i = 0; i < 12; i += 1) {
    const t = controller.inspect("wave-ap").tickets[0];
    if (t?.status === "IMPLEMENTING" || t?.status === "VERIFYING") {
      const lease = [...controller.inspect("wave-ap").leases].find((l) => l.ticketId === "AP-032");
      if (lease) controller.db.deleteLease(lease.resourceKey);
    }
    await controller.tick("wave-ap");
    if (controller.inspect("wave-ap").tickets[0]?.status === "DONE") break;
  }
  const view = controller.inspect("wave-ap");
  assert.equal(view.tickets[0]?.status, "DONE");
  assert.match(view.tickets[0]?.result ?? "", /applied/);
  assert.doesNotMatch(view.tickets[0]?.result ?? "", /stale_fence/);
  void key;
});

test("dead PID writer lease is released on expireStaleLeases", async () => {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  const pid = child.pid;
  assert.ok(pid);
  await new Promise<void>((resolve) => {
    child.on("exit", () => resolve());
    child.kill("SIGKILL");
  });
  const dir = mkdtempSync(join(tmpdir(), "wr032-lease-"));
  const db = new WaveDatabase(join(dir, "wave.sqlite"));
  const clock = new FakeClock(1_700_000_000_000);
  db.putLease({
    resourceKey: "writer:/tmp/repo:game:x",
    generation: 1,
    holder: "dead-op",
    processIdentity: "dead-op-1",
    pid,
    waveId: "w-dead",
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
    process: { holder: "sim", processIdentity: "sim-1", pid: process.pid },
    authority: new MemoryAuthority(),
  });
  const n = expireStaleLeases(ctrl);
  assert.ok(n >= 1);
  assert.equal(db.getLease("writer:/tmp/repo:game:x"), undefined);
});

test("operator scripts: empty inspect does not tick; no approve on plan gate", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const op = readFileSync(join(root, "scripts/wave-operator.sh"), "utf8");
  const backlog = readFileSync(join(root, "scripts/run-backlog-wave.sh"), "utf8");
  assert.match(op, /empty inspect/);
  assert.doesNotMatch(op, /RUNNING\|""\)/);
  assert.match(backlog, /WAVE_JOINED/);
  assert.doesNotMatch(backlog, /wave-operator\.sh" approve/);
});
