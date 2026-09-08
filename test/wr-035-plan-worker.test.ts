import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GrokAcpWorker } from "../src/adapters/acp-worker.js";
import { GrokCliWorker } from "../src/adapters/grok-cli.js";
import { JsonTracker } from "../src/adapters/json-tracker.js";
import { MarkdownTracker, parseTicketFile } from "../src/adapters/markdown-tracker.js";
import type { AcpSpawn, LaunchIntent } from "../src/adapters/ports.js";
import { receiptHasHungReadFile } from "../src/adapters/grok-session-events.js";
import { freezePlanWorker, resolvePlanWorker, stageAgentId, unknownPlanWorker } from "../src/core/plan-worker.js";
import { collectAdmitBlockers } from "../src/core/wave-create.js";
import { DEFAULT_LIMITS } from "../src/domain/types.js";
import { createSimulator, seedWave } from "../src/sim/simulator.js";

function writeReview(forge: string, id: string, verdict: string): void {
  mkdirSync(join(forge, "reviews"), { recursive: true });
  writeFileSync(join(forge, "AGENTS.md"), "# forge\n", "utf8");
  writeFileSync(
    join(forge, "reviews", `${id}.md`),
    `# REVIEW ${id}\n\nVerdict: ${verdict}\n\n## Cheat-mode scan\n- test-weaken: pass\n\n## Learn\n- bite: none\n`,
    "utf8",
  );
}

function writeUxReview(mona: string, id: string, verdict: string): void {
  mkdirSync(join(mona, "reviews"), { recursive: true });
  writeFileSync(join(mona, "AGENTS.md"), "# mona\n", "utf8");
  writeFileSync(join(mona, "reviews", `${id}-ux.md`), `# UX ${id}\n\nVerdict: ${verdict}\n`, "utf8");
}

function writeIssue(root: string, id: string, yaml: string): string {
  mkdirSync(join(root, "issues"), { recursive: true });
  const path = join(root, "issues", `${id}.md`);
  writeFileSync(path, yaml, "utf8");
  return path;
}

async function seedHybrid(input: {
  label: string;
  ticketId: string;
  waveId: string;
  planWorker?: string;
  provider?: string;
  planReviewSkip?: boolean;
  needsUx?: boolean;
  uxSpecPath?: string;
  forge?: string;
  mona?: string;
}) {
  const sim = createSimulator(input.label);
  sim.tracker.seed({
    ticketId: input.ticketId,
    title: input.ticketId,
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: `issues/${input.ticketId}.md`,
    verifyCommand: "true",
    planReviewSkip: input.planReviewSkip ?? false,
    planWorker: input.planWorker,
    provider: input.provider,
    needsUx: input.needsUx,
    uxSpecPath: input.uxSpecPath,
    body: input.ticketId,
  });
  const controller = await seedWave(sim, input.waveId, [input.ticketId], {
    maxTokens: 80_000,
    maxLaunches: 12,
  });
  if (input.forge) Object.assign(controller, { forgeRoot: input.forge });
  if (input.mona) Object.assign(controller, { monaRoot: input.mona });
  return { sim, controller };
}

test("resolvePlanWorker: yaml/json only, not heuristics", () => {
  assert.equal(resolvePlanWorker({ plan_worker: "codex" }), "codex");
  assert.equal(resolvePlanWorker({ planWorker: "codex-acp" }), "codex");
  assert.equal(resolvePlanWorker({ plan_worker: "grok-acp" }), "grok");
  assert.equal(resolvePlanWorker({ worker: "hybrid" }), "codex");
  assert.equal(resolvePlanWorker({ provider: "hybrid" }), "codex");
  assert.equal(resolvePlanWorker({ worker: "hybrid", plan_worker: "grok" }), "grok");
  assert.equal(resolvePlanWorker({ worker: "grok" }), undefined);
  assert.equal(resolvePlanWorker({ labels: ["hybrid", "codex"] }), undefined);
  assert.equal(resolvePlanWorker({ assignee: "codex" }), undefined);
  assert.equal(resolvePlanWorker({ planClass: "hybrid" }), undefined);
  assert.equal(resolvePlanWorker({ preferred_model: "codex" }), undefined);
  assert.equal(unknownPlanWorker("claude"), true);
  assert.equal(unknownPlanWorker("codex"), false);
  assert.equal(unknownPlanWorker(undefined), false);
  assert.equal(stageAgentId("UX_REVIEW", { planWorker: "codex" }), "mona");
  assert.equal(stageAgentId("PLAN", { planWorker: "codex" }), "codex");
  assert.equal(stageAgentId("IMPL", { planWorker: "codex" }), "grok");
  assert.equal(stageAgentId("REVIEW", { planWorker: "codex" }), "grok");
  assert.equal(stageAgentId("PLAN", {}), "grok");
});

test("YAML plan_worker: codex → PLAN codex/impl worktree; IMPL grok; REVIEW grok/forge", async () => {
  const root = mkdtempSync(join(tmpdir(), "wr035-yaml-"));
  const path = writeIssue(
    root,
    "HY-001",
    `---
id: HY-001
title: hybrid
verify: "true"
worker: grok
plan_worker: codex
---
body
`,
  );
  const parsed = parseTicketFile(path, root);
  assert.equal(parsed?.planWorker, "codex");
  const forge = mkdtempSync(join(tmpdir(), "wr035-yaml-forge-"));
  writeReview(forge, "HY-001", "approve");
  const { sim, controller } = await seedHybrid({
    label: "wr035-yaml",
    ticketId: "HY-001",
    waveId: "wave-yaml",
    planWorker: "codex",
    forge,
  });
  await controller.start("wave-yaml");
  await controller.runUntilIdle("wave-yaml");
  const plan = sim.worker.intents.find((i) => i.stage === "PLAN");
  const impl = sim.worker.intents.find((i) => i.stage === "IMPL");
  const review = sim.worker.intents.find((i) => i.stage === "REVIEW");
  assert.equal(plan?.agentId, "codex");
  assert.equal(plan?.worktree, controller.inspect("wave-yaml").tickets[0]?.implWorktree);
  assert.ok(plan?.worktree);
  assert.equal(impl?.agentId, "grok");
  assert.equal(review?.agentId, "grok");
  assert.equal(review?.worktree, forge);
  assert.equal(controller.inspect("wave-yaml").tickets[0]?.planWorker, "codex");
});

test("worker: hybrid without plan_worker is Codex PLAN / Grok IMPL", async () => {
  const root = mkdtempSync(join(tmpdir(), "wr035-hyb-"));
  const path = writeIssue(
    root,
    "HY-002",
    `---
id: HY-002
title: hybrid
verify: "true"
worker: hybrid
---
body
`,
  );
  assert.equal(parseTicketFile(path, root)?.planWorker, "codex");
  assert.equal(freezePlanWorker({ worker: "hybrid" }).planWorker, "codex");
  const { sim, controller } = await seedHybrid({
    label: "wr035-hyb",
    ticketId: "HY-002",
    waveId: "wave-hyb",
    planWorker: "codex",
    provider: "hybrid",
    planReviewSkip: true,
  });
  await controller.start("wave-hyb");
  await controller.runUntilIdle("wave-hyb");
  assert.equal(sim.worker.intents.find((i) => i.stage === "PLAN")?.agentId, "codex");
  assert.equal(sim.worker.intents.find((i) => i.stage === "IMPL")?.agentId, "grok");
});

test("default: no plan_worker, worker grok or unset → PLAN grok", async () => {
  const { sim, controller } = await seedHybrid({
    label: "wr035-def",
    ticketId: "HY-003",
    waveId: "wave-def",
    planReviewSkip: true,
  });
  await controller.start("wave-def");
  await controller.runUntilIdle("wave-def");
  assert.equal(sim.worker.intents.find((i) => i.stage === "PLAN")?.agentId, "grok");
  assert.equal(resolvePlanWorker({ worker: "grok" }), undefined);
  assert.equal(freezePlanWorker({}).planWorker, undefined);
});

test("explicit override: worker hybrid + plan_worker grok → PLAN grok", async () => {
  const root = mkdtempSync(join(tmpdir(), "wr035-ov-"));
  const path = writeIssue(
    root,
    "HY-004",
    `---
id: HY-004
title: override
verify: "true"
worker: hybrid
plan_worker: grok
---
body
`,
  );
  assert.equal(parseTicketFile(path, root)?.planWorker, "grok");
  const { sim, controller } = await seedHybrid({
    label: "wr035-ov",
    ticketId: "HY-004",
    waveId: "wave-ov",
    planWorker: "grok",
    provider: "hybrid",
    planReviewSkip: true,
  });
  await controller.start("wave-ov");
  await controller.runUntilIdle("wave-ov");
  assert.equal(sim.worker.intents.find((i) => i.stage === "PLAN")?.agentId, "grok");
});

test("unknown plan_worker: snapshot does not throw; dry-run blocker; create throws", async () => {
  const root = mkdtempSync(join(tmpdir(), "wr035-unk-"));
  writeIssue(
    root,
    "HY-005",
    `---
id: HY-005
title: bad
verify: "true"
plan_worker: claude
---
body
`,
  );
  writeIssue(
    root,
    "HY-006",
    `---
id: HY-006
title: ok
verify: "true"
worker: grok
---
body
`,
  );
  const tracker = new MarkdownTracker(root);
  const mixed = await tracker.snapshot({ ticketIds: ["HY-005", "HY-006"], repoPath: root });
  assert.equal(mixed[0]?.planWorker, "claude");
  assert.equal(mixed[1]?.planWorker, undefined);
  assert.ok(collectAdmitBlockers(mixed).some((b) => b.code === "unknown_plan_worker" && b.ticketId === "HY-005"));
  const sim = createSimulator("wr035-unk");
  sim.tracker.seed({
    ticketId: "HY-005",
    title: "bad",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/HY-005.md",
    verifyCommand: "true",
    planWorker: "claude",
    body: "bad",
  });
  const controller = sim.open();
  const input = {
    waveId: "wave-unk",
    repoPath: "/tmp/wave-fixture-repo",
    ticketIds: ["HY-005"],
    limits: DEFAULT_LIMITS,
  };
  await assert.rejects(() => controller.dryRun(input), /unknown_plan_worker: HY-005/);
  await assert.rejects(() => controller.create(input), /unknown_plan_worker: HY-005/);
  assert.equal(sim.worker.intents.length, 0);
});

test("JSON ingest: planWorker codex-acp normalizes to codex; hybrid shorthand", async () => {
  const fromAlias = JsonTracker.fromJsonText(
    JSON.stringify([
      {
        ticketId: "J-001",
        sourcePath: "board://J-001",
        verifyCommand: "true",
        planWorker: "codex-acp",
      },
    ]),
  );
  const frozen = await fromAlias.snapshot({ ticketIds: ["J-001"], repoPath: "/tmp" });
  assert.equal(frozen[0]?.planWorker, "codex");
  const fromSnake = JsonTracker.fromJsonText(
    JSON.stringify([{ ticketId: "J-002", sourcePath: "board://J-002", plan_worker: "codex", verifyCommand: "true" }]),
  );
  assert.equal((await fromSnake.snapshot({ ticketIds: ["J-002"], repoPath: "/tmp" }))[0]?.planWorker, "codex");
  const hybrid = JsonTracker.fromJsonText(
    JSON.stringify([{ ticketId: "J-003", sourcePath: "board://J-003", provider: "hybrid", verifyCommand: "true" }]),
  );
  assert.equal((await hybrid.snapshot({ ticketIds: ["J-003"], repoPath: "/tmp" }))[0]?.planWorker, "codex");
});

test("ACP spawn: Codex PLAN is agentId codex, receipt codex-acp, model not grok-4.6; IMPL grok-acp", async () => {
  const root = mkdtempSync(join(tmpdir(), "wr035-acp-"));
  const spawned: Array<{ agentId: string; model?: string }> = [];
  const bySource = new Map<string, { runId: string; sessionId: string; taskId: string }>();
  const acp: AcpSpawn = {
    async spawn(request) {
      spawned.push({ agentId: request.agentId, model: request.model });
      const result = { runId: `run-${request.sourceId}`, sessionId: request.sessionKey, taskId: `t-${request.sourceId}` };
      bySource.set(request.sourceId, result);
      return result;
    },
    async inspect() {
      return { status: "running" };
    },
    async cancel() {
      return { cancelled: false };
    },
    async findBySourceId(sourceId) {
      return bySource.get(sourceId);
    },
  };
  const worker = new GrokAcpWorker({ acp, model: "grok-4.6" });
  const plan = await worker.launch({
    idempotencyKey: "w:HY:PLAN:1",
    waveId: "w",
    ticketId: "HY",
    stage: "PLAN",
    attempt: 1,
    prompt: "plan",
    sessionKey: "sk-p",
    worktree: root,
    outputDir: join(root, "plan"),
    agentId: "codex",
    model: "grok-4.6",
  });
  assert.equal(spawned[0]?.agentId, "codex");
  assert.equal(spawned[0]?.model, undefined);
  assert.equal(plan.provider, "codex-acp");
  assert.notEqual(plan.model, "grok-4.6");
  const impl = await worker.launch({
    idempotencyKey: "w:HY:IMPL:1",
    waveId: "w",
    ticketId: "HY",
    stage: "IMPL",
    attempt: 1,
    prompt: "impl",
    sessionKey: "sk-i",
    worktree: root,
    outputDir: join(root, "impl"),
    agentId: "grok",
  });
  assert.equal(impl.provider, "grok-acp");
  const restarted = new GrokAcpWorker({ acp, model: "grok-4.6" });
  const recovered = await restarted.recover({
    idempotencyKey: "w:HY:PLAN:1",
    waveId: "w",
    ticketId: "HY",
    stage: "PLAN",
    attempt: 1,
    prompt: "plan",
    sessionKey: "sk-p",
    worktree: root,
    outputDir: join(root, "plan"),
    agentId: "codex",
    model: "grok-4.6",
  });
  assert.equal(recovered?.provider, "codex-acp");
  assert.notEqual(recovered?.model, "grok-4.6");
});

test("CLI refuse Codex PLAN; IMPL grok CLI still allowed", async () => {
  const root = mkdtempSync(join(tmpdir(), "wr035-cli-"));
  const worker = new GrokCliWorker({
    repoPath: root,
    launcherPath: "/bin/true",
    exec: async () => ({ stdout: "builder_pid=1" }),
  });
  const planIntent: LaunchIntent = {
    idempotencyKey: "w:T:PLAN:1",
    waveId: "w",
    ticketId: "T",
    stage: "PLAN",
    attempt: 1,
    prompt: "plan",
    sessionKey: "s",
    worktree: root,
    outputDir: join(root, "plan"),
    agentId: "codex",
  };
  await assert.rejects(() => worker.launch(planIntent), /refuses Codex PLAN/);
  const inspect = await worker.inspect({
    idempotencyKey: "w:T:PLAN:1",
    provider: "codex-acp",
    outputDir: join(root, "plan"),
  });
  assert.equal(inspect.status, "failed");
  assert.match(inspect.error ?? "", /Codex PLAN/);
  const impl = await worker.launch({
    idempotencyKey: "w:T:IMPL:1",
    waveId: "w",
    ticketId: "T",
    stage: "IMPL",
    attempt: 1,
    prompt: "impl",
    sessionKey: "s-i",
    worktree: root,
    outputDir: join(root, "impl"),
    agentId: "grok",
  });
  assert.equal(impl.provider, "grok-cli");
});

test("no Grok substitute: refused Codex spawn leaves PLAN not succeeded and no grok PLAN intent", async () => {
  const acp: AcpSpawn = {
    async spawn(request) {
      if (request.agentId === "codex") throw new Error("OpenClaw refused the ACP sessions_spawn call.");
      return { runId: "r", sessionId: "s", taskId: "t" };
    },
    async inspect() {
      return { status: "running" };
    },
    async cancel() {
      return { cancelled: false };
    },
    async findBySourceId() {
      return undefined;
    },
  };
  const worker = new GrokAcpWorker({ acp });
  const root = mkdtempSync(join(tmpdir(), "wr035-nosub-"));
  await assert.rejects(
    () =>
      worker.launch({
        idempotencyKey: "w:HY:PLAN:1",
        waveId: "w",
        ticketId: "HY",
        stage: "PLAN",
        attempt: 1,
        prompt: "plan",
        sessionKey: "sk",
        worktree: root,
        outputDir: join(root, "plan"),
        agentId: "codex",
      }),
    /refused the ACP sessions_spawn/,
  );
  const { sim, controller } = await seedHybrid({
    label: "wr035-nosub",
    ticketId: "HY-009",
    waveId: "wave-nosub",
    planWorker: "codex",
    planReviewSkip: true,
  });
  const orig = sim.worker.launch.bind(sim.worker);
  sim.worker.launch = async (intent) => {
    if (intent.agentId === "codex") {
      sim.worker.intents.push(intent);
      throw new Error("OpenClaw refused the ACP sessions_spawn call.");
    }
    return orig(intent);
  };
  await controller.start("wave-nosub");
  await controller.runUntilIdle("wave-nosub");
  const view = controller.inspect("wave-nosub");
  assert.ok(view.stages.every((s) => s.stage !== "PLAN" || s.status !== "SUCCEEDED"));
  assert.ok(!sim.worker.intents.some((i) => i.stage === "PLAN" && i.agentId === "grok"));
  assert.ok(sim.worker.intents.some((i) => i.stage === "PLAN" && i.agentId === "codex"));
});

test("hung-read skip: receiptHasHungReadFile is false for codex-acp even if grok session exists", () => {
  const home = mkdtempSync(join(tmpdir(), "wr035-hang-"));
  const cwd = "/tmp/isolated/HY-010";
  const session = join(home, "sessions", encodeURIComponent(cwd), "sess-1");
  mkdirSync(session, { recursive: true });
  const t0 = "2026-08-29T20:00:00.000Z";
  writeFileSync(
    join(session, "events.jsonl"),
    `${JSON.stringify({ ts: t0, type: "tool_started", tool_name: "read_file" })}\n`,
    "utf8",
  );
  const now = Date.parse(t0) + 60_000;
  assert.equal(receiptHasHungReadFile({ idempotencyKey: "k", cwd, provider: "grok-acp" }, now, 60_000, home), true);
  assert.equal(receiptHasHungReadFile({ idempotencyKey: "k", cwd, provider: "codex-acp" }, now, 60_000, home), false);
});

test("UX_REVIEW + hybrid: Mona for UX, Codex PLAN, Grok IMPL", async () => {
  const forge = mkdtempSync(join(tmpdir(), "wr035-ux-"));
  const mona = mkdtempSync(join(tmpdir(), "wr035-uxm-"));
  const spec = join(mona, "UX_SPEC.md");
  writeFileSync(spec, "# HUD\nscreens: one\n", "utf8");
  writeReview(forge, "HY-011", "approve");
  writeUxReview(mona, "HY-011", "approve");
  const { sim, controller } = await seedHybrid({
    label: "wr035-ux",
    ticketId: "HY-011",
    waveId: "wave-ux",
    planWorker: "codex",
    needsUx: true,
    uxSpecPath: spec,
    forge,
    mona,
  });
  await controller.start("wave-ux");
  await controller.runUntilIdle("wave-ux");
  const plan = sim.worker.intents.find((i) => i.stage === "PLAN");
  const review = sim.worker.intents.find((i) => i.stage === "REVIEW");
  const ux = sim.worker.intents.find((i) => i.stage === "UX_REVIEW");
  const impl = sim.worker.intents.find((i) => i.stage === "IMPL");
  assert.equal(plan?.agentId, "codex");
  assert.equal(review?.agentId, "grok");
  assert.equal(ux?.agentId, "mona");
  assert.equal(impl?.agentId, "grok");
});
