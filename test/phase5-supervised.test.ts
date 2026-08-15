import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MarkdownTracker } from "../src/adapters/markdown-tracker.js";
import { GrokCliWorker } from "../src/adapters/grok-cli.js";
import { stageAttemptDir, writeStageTerminal } from "../src/adapters/stage-artifacts.js";
import { MockUsage, MockWorker, MockWorkflow, SafePolicy } from "../src/adapters/mocks.js";
import { boundedNativePrompt } from "../src/adapters/taskflow.js";
import { GitWorkspace } from "../src/adapters/workspace.js";
import { runOperator } from "../src/cli/operations.js";
import { WaveController } from "../src/core/controller.js";
import { normalizeSelectedDependencies, validateTicketGraph } from "../src/core/manifest.js";
import { FakeClock, SequentialIds } from "../src/domain/clock.js";
import { releaseLease } from "../src/core/lease.js";
import { SAFETY, assertBoundedWaveRequest, assertSupervisedOneTicketLaunch } from "../src/domain/safety.js";
import { DEFAULT_LIMITS } from "../src/domain/types.js";
import { openCliController } from "../src/runtime.js";
import { WaveDatabase } from "../src/store/database.js";

function initDirtyRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wave-p5-primary-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "wave@example.test"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Wave Runner"], { cwd: dir });
  mkdirSync(join(dir, "issues"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "primary\n", "utf8");
  writeFileSync(
    join(dir, "issues", "EX-002.md"),
    `---
id: EX-002
title: Clip through ground
status: open
depends_on: [EX-001]
verify: true
---

# EX-002
`,
    "utf8",
  );
  writeFileSync(
    join(dir, "issues", "EX-001.md"),
    `---
id: EX-001
title: Already done dep
status: done
depends_on: []
---

# EX-001
`,
    "utf8",
  );
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  writeFileSync(join(dir, "DIRTY.txt"), "user change\n", "utf8");
  return dir;
}

function porcelain(repo: string): string {
  return execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" });
}

function makeSupervisedController(
  repo: string,
  isolatedRoot: string,
  worker = new MockWorker(),
  launchMode: "mock" | "supervised-one-ticket" = "mock",
): WaveController {
  return new WaveController({
    db: new WaveDatabase(join(isolatedRoot, "wave.sqlite")),
    clock: new FakeClock(),
    ids: new SequentialIds(),
    tracker: new MarkdownTracker(repo),
    workflow: new MockWorkflow(),
    worker,
    usage: new MockUsage(),
    workspace: new GitWorkspace(),
    policy: new SafePolicy(),
    process: { holder: "p5", processIdentity: "p5-1" },
    worktreeRoot: join(isolatedRoot, "worktrees"),
    artifactRoot: join(isolatedRoot, "artifacts"),
    launchMode,
    disableSourceMirror: true,
  });
}

test("Phase 5: general production drain and worker launch stay disabled", () => {
  assert.equal(SAFETY.productionDrainEnabled, false);
  assert.equal(SAFETY.overnightEnabled, false);
  assert.equal(SAFETY.productionWorkerLaunchEnabled, false);
  assert.equal(SAFETY.deployPushEnabled, false);
  assert.equal(SAFETY.allowActiveGatewayRestart, false);
  assert.equal(SAFETY.supervisedOneTicketLaunchAllowed, true);
  assert.throws(() => assertBoundedWaveRequest({ drainEverything: true, ticketIds: ["EX-002"] }), /drain/);
  assert.throws(
    () =>
      assertSupervisedOneTicketLaunch({
        ticketIds: ["EX-002", "EX-003"],
        operatorAction: true,
        isolatedWorktree: true,
      }),
    /singleton/,
  );
  assert.throws(
    () =>
      assertSupervisedOneTicketLaunch({
        ticketIds: ["EX-002"],
        operatorAction: false,
        isolatedWorktree: true,
      }),
    /operator action/,
  );
});

test("Phase 5: supervised one-ticket start is allowed (unrestricted drain still off)", async () => {
  const repo = initDirtyRepo();
  const isolated = mkdtempSync(join(tmpdir(), "wave-p5-iso-"));
  const worker = new MockWorker();
  const controller = makeSupervisedController(repo, isolated, worker, "supervised-one-ticket");
  await controller.create({
    waveId: "sup-one",
    repoPath: repo,
    ticketIds: ["EX-002"],
    limits: DEFAULT_LIMITS,
    supervisedOneTicket: true,
    supervisedBoundedPilot: true,
    isolatedWorktreeRoot: isolated,
    operatorAction: true,
  });
  // Restored 2026-08-15: supervised bounded/one-ticket is the intentional real path.
  const started = await controller.start("sup-one", undefined, undefined, {
    supervisedOneTicket: true,
    supervisedBoundedPilot: true,
    operatorAction: true,
  });
  assert.ok(["RUNNING", "AWAITING_PLAN_GATE", "WAITING_APPROVAL", "COMPLETED"].includes(started.wave.status));
  assert.equal(SAFETY.productionDrainEnabled, false);
  assert.equal(SAFETY.unrestrictedDrainEnabled, false);
});

test("Phase 5: multi-ticket supervised create/start is refused", async () => {
  const repo = initDirtyRepo();
  writeFileSync(
    join(repo, "issues", "EX-003.md"),
    `---
id: EX-003
title: Other
status: open
depends_on: []
---
`,
    "utf8",
  );
  const isolated = mkdtempSync(join(tmpdir(), "wave-p5-multi-"));
  const controller = makeSupervisedController(repo, isolated);
  await assert.rejects(
    () =>
      controller.create({
        waveId: "sup-multi",
        repoPath: repo,
        ticketIds: ["EX-002", "EX-003"],
        limits: DEFAULT_LIMITS,
        supervisedOneTicket: true,
        isolatedWorktreeRoot: isolated,
        operatorAction: true,
      }),
    /singleton/,
  );
});

test("Phase 5: already-done external dependencies are normalized", async () => {
  const normalized = normalizeSelectedDependencies(
    [
      {
        ticketId: "MUD-035",
        title: "raise pit",
        contentHash: "h",
        dependsOn: ["MUD-034"],
        order: 1,
        sourcePath: "issues/MUD-035.md",
      },
    ],
    [
      { ticketId: "MUD-035", status: "open" },
      { ticketId: "MUD-034", status: "done" },
    ],
  );
  assert.deepEqual(normalized[0]?.dependsOn, []);
  assert.equal(normalized[0]?.satisfiedExternalDeps?.[0]?.ticketId, "MUD-034");
  validateTicketGraph(normalized);

  assert.throws(
    () =>
      normalizeSelectedDependencies(
        [
          {
            ticketId: "MUD-035",
            title: "raise pit",
            contentHash: "h",
            dependsOn: ["MUD-099"],
            order: 1,
            sourcePath: "issues/MUD-035.md",
          },
        ],
        [{ ticketId: "MUD-035", status: "open" }],
      ),
    /Missing dependency MUD-099/,
  );
  assert.throws(
    () =>
      normalizeSelectedDependencies(
        [
          {
            ticketId: "MUD-035",
            title: "raise pit",
            contentHash: "h",
            dependsOn: ["MUD-040"],
            order: 1,
            sourcePath: "issues/MUD-035.md",
          },
        ],
        [
          { ticketId: "MUD-035", status: "open" },
          { ticketId: "MUD-040", status: "open" },
        ],
      ),
    /Open dependency MUD-040/,
  );

  const repo = initDirtyRepo();
  const tracker = new MarkdownTracker(repo);
  const snapped = await tracker.snapshot({ ticketIds: ["EX-002"], repoPath: repo });
  assert.deepEqual(snapped[0]?.dependsOn, []);
  assert.equal(snapped[0]?.satisfiedExternalDeps?.[0]?.ticketId, "EX-001");
});

test("Phase 5: fixture simulation duplicate start does not launch twice", async () => {
  const repo = initDirtyRepo();
  const isolated = mkdtempSync(join(tmpdir(), "wave-p5-dup-"));
  const worker = new MockWorker();
  const controller = makeSupervisedController(repo, isolated, worker);
  await controller.create({
    waveId: "sup-dup",
    repoPath: repo,
    ticketIds: ["EX-002"],
    limits: DEFAULT_LIMITS,
    supervisedOneTicket: true,
    isolatedWorktreeRoot: isolated,
    operatorAction: true,
  });
  await controller.start("sup-dup", undefined, undefined, {
    supervisedOneTicket: true,
    operatorAction: true,
  });
  await controller.runUntilIdle("sup-dup", 32, {
    supervisedOneTicket: true,
    operatorAction: true,
  });
  const first = worker.launches;
  assert.equal(first, 1);
  await controller.start("sup-dup", undefined, undefined, {
    supervisedOneTicket: true,
    operatorAction: true,
  });
  await controller.runUntilIdle("sup-dup", 32, {
    supervisedOneTicket: true,
    operatorAction: true,
  });
  assert.equal(worker.launches, first);
});

test("Phase 5: fixture simulation leaves a dirty primary checkout untouched", async () => {
  const repo = initDirtyRepo();
  const isolated = mkdtempSync(join(tmpdir(), "wave-p5-dirty-"));
  const before = porcelain(repo);
  const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const controller = makeSupervisedController(repo, isolated);
  await controller.create({
    waveId: "sup-dirty",
    repoPath: repo,
    ticketIds: ["EX-002"],
    limits: DEFAULT_LIMITS,
    supervisedOneTicket: true,
    isolatedWorktreeRoot: isolated,
    operatorAction: true,
  });
  await controller.start("sup-dirty", undefined, undefined, {
    supervisedOneTicket: true,
    operatorAction: true,
  });
  await controller.runUntilIdle("sup-dirty", 32, {
    supervisedOneTicket: true,
    operatorAction: true,
  });
  const waiting = controller.inspect("sup-dirty");
  const ticket = waiting.tickets[0];
  if (ticket?.status === "PLAN_REVIEW") {
    controller.approve("sup-dirty", ticket.ticketId, ticket.revision);
    await controller.runUntilIdle("sup-dirty", 32, {
      supervisedOneTicket: true,
      operatorAction: true,
    });
  }
  assert.equal(porcelain(repo), before);
  const afterHead = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(afterHead, head);
  assert.equal(readFileSync(join(repo, "DIRTY.txt"), "utf8"), "user change\n");
  const view = controller.inspect("sup-dirty");
  assert.ok(view.tickets[0]?.implWorktree === undefined || !view.tickets[0]?.implWorktree.startsWith(repo + "/"));
});

test("Phase 5: mock CLI start is not a truthful real worker path", async () => {
  const repo = initDirtyRepo();
  const isolated = mkdtempSync(join(tmpdir(), "wave-p5-mockcli-"));
  const controller = new WaveController({
    db: new WaveDatabase(join(isolated, "wave.sqlite")),
    clock: new FakeClock(),
    tracker: new MarkdownTracker(repo),
    workflow: new MockWorkflow(),
    worker: new MockWorker(),
    usage: new MockUsage(),
    workspace: new GitWorkspace(),
    policy: new SafePolicy(),
    process: { holder: "cli", processIdentity: "cli-1" },
    launchMode: "mock",
    disableSourceMirror: true,
  });
  const caps = await runOperator(controller, { op: "capabilities" });
  assert.equal((caps as { launchMode: string }).launchMode, "mock");
  assert.equal((caps as { productionWorkerLaunchEnabled: boolean }).productionWorkerLaunchEnabled, false);
});

test("Phase 5: fixture simulations in one DB do not collide stage/outbox ids", async () => {
  const repo = initDirtyRepo();
  const isolated = mkdtempSync(join(tmpdir(), "wave-p5-id-"));
  const worker = new MockWorker();
  const first = makeSupervisedController(repo, isolated, worker);
  await first.create({
    waveId: "wave-a",
    repoPath: repo,
    ticketIds: ["EX-002"],
    limits: DEFAULT_LIMITS,
    supervisedOneTicket: true,
    isolatedWorktreeRoot: isolated,
    operatorAction: true,
  });
  await first.start("wave-a", undefined, undefined, {
    supervisedOneTicket: true,
    operatorAction: true,
  });
  first.cancel("wave-a");
  const second = makeSupervisedController(repo, isolated, worker);
  await second.create({
    waveId: "wave-b",
    repoPath: repo,
    ticketIds: ["EX-002"],
    limits: DEFAULT_LIMITS,
    supervisedOneTicket: true,
    isolatedWorktreeRoot: isolated,
    operatorAction: true,
  });
  await second.start("wave-b", undefined, undefined, {
    supervisedOneTicket: true,
    operatorAction: true,
  });
  const view = second.inspect("wave-b");
  assert.equal(view.tickets[0]?.status, "PLANNING");
  assert.equal(view.outbox.length, 1);
  assert.equal(view.stages.length, 1);
  assert.match(view.outbox[0]?.outboxId ?? "", /^wave-b:/);
  assert.notEqual(view.outbox[0]?.outboxId, first.inspect("wave-a").outbox[0]?.outboxId);
});

test("Phase 5: grok CLI worker records a real launch receipt without mocking success", async () => {
  const isolated = mkdtempSync(join(tmpdir(), "wave-p5-grok-"));
  const outDir = stageAttemptDir({ root: isolated, waveId: "w", ticketId: "EX-002", stage: "PLAN", attempt: 1 });
  let launched = 0;
  const worker = new GrokCliWorker({
    repoPath: isolated,
    launcherPath: "/bin/true",
    exec: async () => {
      launched += 1;
      writeFileSync(join(outDir, "PLAN.md"), "# PLAN EX-002\n", "utf8");
      writeStageTerminal(outDir, {
        idempotencyKey: "w:EX-002:PLAN:1", waveId: "w", ticketId: "EX-002",
        stage: "PLAN", attempt: 1, status: "succeeded",
      });
      return { stdout: "ok ticket=EX-002 builder_pid=4242", pid: "4242" };
    },
  });
  const receipt = await worker.launch({
    idempotencyKey: "w:EX-002:PLAN:1",
    waveId: "w",
    ticketId: "EX-002",
    stage: "PLAN",
    prompt: "plan",
    sessionKey: "sess",
  });
  assert.equal(launched, 1);
  assert.equal(receipt.provider, "grok-cli");
  assert.equal(receipt.model, "grok-4.6");
  const truth = await worker.inspect(receipt);
  assert.equal(truth.status, "succeeded");
  assert.equal(receipt.outputDir, outDir);
});

test("Phase 5: grok inspect survives a fresh worker using receipt.outputDir", async () => {
  const isolated = mkdtempSync(join(tmpdir(), "wave-p5-grok-restart-"));
  const worktree = join(isolated, "worktree");
  const outDir = stageAttemptDir({ root: worktree, waveId: "w", ticketId: "WR-001", stage: "IMPL", attempt: 1 });
  mkdirSync(outDir, { recursive: true });
  const first = new GrokCliWorker({
    repoPath: isolated,
    launcherPath: "/bin/true",
    exec: async () => {
      writeFileSync(join(outDir, "IMPL_DONE.json"), '{"ok":true}\n', "utf8");
      writeStageTerminal(outDir, {
        idempotencyKey: "w:WR-001:IMPL:1", waveId: "w", ticketId: "WR-001",
        stage: "IMPL", attempt: 1, status: "succeeded",
      });
      return { stdout: "ok ticket=WR-001 builder_pid=99", pid: "99" };
    },
  });
  const receipt = await first.launch({
    idempotencyKey: "w:WR-001:IMPL:1",
    waveId: "w",
    ticketId: "WR-001",
    stage: "IMPL",
    prompt: "impl",
    sessionKey: "sess",
    worktree,
  });
  assert.equal(receipt.outputDir, outDir);
  const restarted = new GrokCliWorker({
    repoPath: isolated,
    launcherPath: "/bin/true",
  });
  const truth = await restarted.inspect(receipt);
  assert.equal(truth.status, "succeeded");
  assert.equal(truth.summary, '{"ok":true}');
});

test("Phase 5: supervised CLI create stamps singleton flags; mock create does not", async () => {
  const repo = initDirtyRepo();
  const isolated = mkdtempSync(join(tmpdir(), "wave-p5-cli-create-"));
  const supervised = openCliController({
    dbPath: join(isolated, "supervised.sqlite"),
    repoPath: repo,
    supervised: true,
    worktreeRoot: join(isolated, "worktrees"),
    artifactRoot: join(isolated, "artifacts"),
    launcherPath: "/bin/true",
  });
  const created = await runOperator(supervised, {
    op: "create",
    input: {
      waveId: "cli-sup",
      repoPath: repo,
      ticketIds: ["EX-002"],
      limits: DEFAULT_LIMITS,
      supervisedOneTicket: true,
      isolatedWorktreeRoot: join(isolated, "worktrees"),
      operatorAction: true,
    },
  });
  assert.equal((created as { manifest: { supervisedOneTicket: boolean } }).manifest.supervisedOneTicket, true);

  const mock = openCliController({
    dbPath: join(isolated, "mock.sqlite"),
    repoPath: repo,
    supervised: false,
    worktreeRoot: join(isolated, "worktrees-mock"),
  });
  const mockCreated = await runOperator(mock, {
    op: "create",
    input: {
      waveId: "cli-mock",
      repoPath: repo,
      ticketIds: ["EX-002"],
      limits: DEFAULT_LIMITS,
    },
  });
  assert.equal((mockCreated as { manifest: { supervisedOneTicket: boolean } }).manifest.supervisedOneTicket, false);
  const caps = await runOperator(mock, { op: "capabilities" });
  assert.deepEqual((caps as { phases: string[] }).phases, ["M0", "P1", "P2", "P3", "P4", "P5"]);
});

test("Phase 5: sequential CLI processes share a stable operator identity for lease release", () => {
  const repo = initDirtyRepo();
  const isolated = mkdtempSync(join(tmpdir(), "wave-p5-seq-cli-"));
  const first = openCliController({
    dbPath: join(isolated, "wave.sqlite"),
    repoPath: repo,
    supervised: true,
    worktreeRoot: join(isolated, "worktrees"),
    launcherPath: "/bin/true",
  });
  const second = openCliController({
    dbPath: join(isolated, "wave.sqlite"),
    repoPath: repo,
    supervised: true,
    worktreeRoot: join(isolated, "worktrees"),
    launcherPath: "/bin/true",
  });
  assert.equal(first.process.processIdentity, "cli-supervised-operator");
  assert.equal(second.process.processIdentity, first.process.processIdentity);
  assert.equal(first.process.holder, second.process.holder);
  first.db.putLease({
    resourceKey: "repo-writer:fixture",
    generation: 1,
    holder: first.process.holder,
    processIdentity: first.process.processIdentity,
    pid: 111,
    pidStartTime: "start-a",
    expiresAt: first.clock.now() + 60_000,
    createdAt: first.clock.now(),
    waveId: "seq-cli",
    ticketId: "EX-002",
  });
  releaseLease({
    current: first.db.getLease("repo-writer:fixture")!,
    claimant: second.process,
    expectedGeneration: 1,
    now: second.clock.now(),
  });
});

test("Phase 5: native child prompt stays bounded and tool-free", () => {
  const prompt = boundedNativePrompt({
    idempotencyKey: "w:WR-001:PLAN:1",
    waveId: "w",
    ticketId: "WR-001",
    stage: "PLAN",
    prompt: "PLAN WR-001 docs note",
    sessionKey: "sess",
    worktree: "/tmp/wave-worktree",
  });
  assert.match(prompt, /WAVE_RUNNER_P5_CHILD_OK/);
  assert.match(prompt, /Do not use tools/);
  assert.match(prompt, /Isolated worktree only/);
});
