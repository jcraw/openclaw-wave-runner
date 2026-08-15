import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GrokCliWorker } from "../src/adapters/grok-cli.js";
import { stageAttemptDir, writeStageTerminal } from "../src/adapters/stage-artifacts.js";
import { MockTracker, MockUsage, MockWorker, MockWorkflow, MockWorkspace, SafePolicy } from "../src/adapters/mocks.js";
import { WaveController } from "../src/core/controller.js";
import { FakeClock, SequentialIds } from "../src/domain/clock.js";
import { SAFETY, assertSupervisedBoundedLaunch } from "../src/domain/safety.js";
import { DEFAULT_LIMITS } from "../src/domain/types.js";
import { WaveDatabase } from "../src/store/database.js";

function fixture() {
  const tracker = new MockTracker();
  for (let i = 1; i <= 4; i += 1) {
    tracker.seed({
      ticketId: `FX-00${i}`,
      title: `Fixture ${i}`,
      contentHash: "",
      dependsOn: i === 1 ? [] : [`FX-00${i - 1}`],
      order: i,
      sourcePath: `issues/FX-00${i}.md`,
      planClass: "safe-policy",
      verifyCommand: "true",
      body: `fixture ${i}`,
    });
  }
  const worker = new MockWorker();
  const workspace = new MockWorkspace();
  const root = mkdtempSync(join(tmpdir(), "wave-p6-"));
  const controller = new WaveController({
    db: new WaveDatabase(join(root, "wave.sqlite")),
    clock: new FakeClock(),
    ids: new SequentialIds(),
    tracker,
    workflow: new MockWorkflow(),
    worker,
    usage: new MockUsage(),
    workspace,
    policy: new SafePolicy(),
    process: { holder: "p6", processIdentity: "p6-operator" },
    worktreeRoot: join(root, "worktrees"),
    artifactRoot: join(root, "artifacts"),
    launchMode: "supervised-bounded",
    disableSourceMirror: true,
  });
  return { controller, worker, workspace, root };
}

const pilotLimits = {
  ...DEFAULT_LIMITS,
  maxTokens: 48_000,
  maxLaunches: 6,
  maxWallTimeMs: 0,
  repoConcurrency: 1 as const,
};

const operator = { supervisedBoundedPilot: true, operatorAction: true };

test("Phase 6: supervised real-worker pilot admits only explicit 1-3 ticket lists and hard caps", () => {
  assert.equal(SAFETY.productionDrainEnabled, false);
  assert.equal(SAFETY.overnightEnabled, false);
  assert.equal(SAFETY.deployPushEnabled, false);
  assert.equal(SAFETY.recurringLlmPollingEnabled, false);
  assert.doesNotThrow(() => assertSupervisedBoundedLaunch({
    ticketIds: ["FX-001", "FX-002", "FX-003"],
    operatorAction: true,
    isolatedWorktree: true,
    limits: pilotLimits,
  }));
  assert.throws(() => assertSupervisedBoundedLaunch({
    ticketIds: ["FX-001", "FX-002", "FX-003", "FX-004"],
    operatorAction: true,
    isolatedWorktree: true,
    limits: pilotLimits,
  }), /at most 3/);
  assert.throws(() => assertSupervisedBoundedLaunch({
    ticketIds: ["FX-001", "FX-002"],
    operatorAction: false,
    isolatedWorktree: true,
    limits: pilotLimits,
  }), /operator action/);
  assert.throws(() => assertSupervisedBoundedLaunch({
    ticketIds: ["FX-001", "FX-002"],
    operatorAction: true,
    isolatedWorktree: true,
    limits: { ...pilotLimits, maxLaunches: 7 },
  }), /maxLaunches/);
  assert.doesNotThrow(() => assertSupervisedBoundedLaunch({
    ticketIds: ["FX-001", "FX-002"],
    operatorAction: true,
    isolatedWorktree: true,
    limits: { ...pilotLimits, maxWallTimeMs: 24 * 60 * 60_000 },
  }));
  assert.throws(() => assertSupervisedBoundedLaunch({
    ticketIds: ["FX-001", "FX-002"],
    operatorAction: true,
    isolatedWorktree: true,
    limits: { ...pilotLimits, maxWallTimeMs: -1 },
  }), /maxWallTimeMs/);
});

test("Phase 6: two-ticket supervised pilot is serial, isolated, immutable, and operator-ticked", async () => {
  const { controller, worker, workspace } = fixture();
  const created = await controller.create({
    waveId: "pilot-two",
    repoPath: "/fixture/repo",
    ticketIds: ["FX-001", "FX-002"],
    limits: { ...pilotLimits, maxLaunches: 4 },
    supervisedBoundedPilot: true,
    isolatedWorktreeRoot: controller.worktreeRoot,
    operatorAction: true,
  });
  assert.deepEqual(created.manifest.tickets.map((ticket) => ticket.ticketId), ["FX-001", "FX-002"]);
  assert.equal(created.manifest.operatorActionRequired, true);
  assert.equal(created.manifest.deployPush, false);
  assert.equal(created.manifest.productionDrain, false);
  assert.equal(created.manifest.recurringLlmPolling, false);
  await assert.rejects(() => controller.start("pilot-two"), /operator action/);
  await controller.start("pilot-two", undefined, undefined, operator);
  await assert.rejects(() => controller.tick("pilot-two"), /operator action/);
  await controller.runUntilIdle("pilot-two", 64, operator);
  const view = controller.inspect("pilot-two");
  assert.equal(view.wave.status, "COMPLETED");
  assert.equal(worker.launches, 4);
  assert.equal(view.wave.counters.launches, 4);
  assert.equal(view.tickets.every((ticket) => ticket.status === "DONE"), true);
  assert.equal(workspace.worktrees.length, 2);
  assert.equal(new Set(workspace.worktrees).size, 2);
  assert.equal(view.leases.filter((lease) => lease.resourceKey.startsWith("repo-writer:")).length, 0);
  await assert.rejects(() => controller.create({
    waveId: "pilot-two",
    repoPath: "/fixture/repo",
    ticketIds: ["FX-001", "FX-003"],
    limits: { ...pilotLimits, maxLaunches: 4 },
    supervisedBoundedPilot: true,
    isolatedWorktreeRoot: controller.worktreeRoot,
    operatorAction: true,
  }), /different immutable/);
});

test("Phase 6: hard launch cap stops a three-ticket pilot before a seventh launch", async () => {
  const { controller, worker } = fixture();
  await controller.create({
    waveId: "pilot-three-capped",
    repoPath: "/fixture/repo",
    ticketIds: ["FX-001", "FX-002", "FX-003"],
    limits: { ...pilotLimits, maxLaunches: 5 },
    supervisedBoundedPilot: true,
    isolatedWorktreeRoot: controller.worktreeRoot,
    operatorAction: true,
  });
  await controller.start("pilot-three-capped", undefined, undefined, operator);
  await assert.rejects(() => controller.runUntilIdle("pilot-three-capped", 64, operator), /max_launches would be exceeded/);
  const view = controller.inspect("pilot-three-capped");
  assert.equal(worker.launches, 5);
  assert.equal(view.wave.counters.launches, 5);
  assert.ok(view.wave.counters.committedTokens + view.wave.counters.reservedTokens + view.wave.counters.indeterminateTokens <= pilotLimits.maxTokens);
});

test("Phase 6: PLAN launches in an isolated worktree, not the primary checkout", async () => {
  const { controller, worker } = fixture();
  await controller.create({
    waveId: "pilot-plan-iso",
    repoPath: "/fixture/repo",
    ticketIds: ["FX-001"],
    limits: { ...pilotLimits, maxLaunches: 2 },
    supervisedBoundedPilot: true,
    isolatedWorktreeRoot: controller.worktreeRoot,
    operatorAction: true,
  });
  await controller.start("pilot-plan-iso", undefined, undefined, operator);
  await controller.tick("pilot-plan-iso", operator);
  const planLaunch = worker.intents.find((intent) => intent.stage === "PLAN");
  assert.ok(planLaunch?.worktree);
  assert.ok(planLaunch?.worktree?.includes("worktrees"));
  assert.equal(planLaunch?.worktree?.startsWith("/fixture/repo"), false);
  const view = controller.inspect("pilot-plan-iso");
  assert.ok(view.tickets[0]?.implWorktree);
  assert.equal(view.tickets[0]?.implWorktree, planLaunch?.worktree);
});

test("Phase 6: grok fallback accepts only the exact PLAN stage attempt attestation", async () => {
  const isolated = mkdtempSync(join(tmpdir(), "wave-p6-plan-inspect-"));
  const worktree = join(isolated, "worktree");
  const outDir = stageAttemptDir({ root: worktree, waveId: "w", ticketId: "MUD-036", stage: "PLAN", attempt: 1 });
  mkdirSync(outDir, { recursive: true });
  const worker = new GrokCliWorker({
    repoPath: isolated,
    launcherPath: "/bin/true",
    exec: async () => {
      writeFileSync(join(outDir, "outcome.txt"), "status=ok\nartifact=PLAN.md present\n", "utf8");
      writeFileSync(join(outDir, "PLAN.md"), "# PLAN MUD-036\n\nAdd warn-only duplication gate.\n", "utf8");
      writeStageTerminal(outDir, {
        idempotencyKey: "w:MUD-036:PLAN:1", waveId: "w", ticketId: "MUD-036",
        stage: "PLAN", attempt: 1, status: "succeeded",
      });
      return { stdout: "ok ticket=MUD-036 builder_pid=77", pid: "77" };
    },
  });
  const receipt = await worker.launch({
    idempotencyKey: "w:MUD-036:PLAN:1",
    waveId: "w",
    ticketId: "MUD-036",
    stage: "PLAN",
    prompt: "plan",
    sessionKey: "sess",
    worktree,
  });
  const truth = await worker.inspect(receipt);
  assert.equal(truth.status, "succeeded");
  assert.match(truth.summary ?? "", /duplication gate/);
  assert.equal(truth.outputRef, join(outDir, "PLAN.md"));
});
