import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GrokAcpWorker } from "../src/adapters/acp-worker.js";
import { GrokCliWorker } from "../src/adapters/grok-cli.js";
import { parseTicketFile } from "../src/adapters/markdown-tracker.js";
import type { AcpSpawn, LaunchIntent } from "../src/adapters/ports.js";
import {
  inspectReceiptArtifacts,
  writeStageTerminal,
} from "../src/adapters/stage-artifacts.js";
import { resolveNeedsUx } from "../src/core/ux-review-skip.js";
import { checkUxReview, resolveMonaWorkspace } from "../src/core/ux-review.js";
import { parseStageFromIdempotencyKey } from "../src/core/stage-paths.js";
import { DEFAULT_LIMITS } from "../src/domain/types.js";
import { createSimulator, seedWave } from "../src/sim/simulator.js";

function writeReview(forge: string, id: string, verdict: string, theater = false): void {
  mkdirSync(join(forge, "reviews"), { recursive: true });
  writeFileSync(join(forge, "AGENTS.md"), "# forge\n", "utf8");
  const body = theater
    ? `# REVIEW ${id}\n\nLooks fine.\n`
    : `# REVIEW ${id}

Verdict: ${verdict}

## Cheat-mode scan
- test-weaken: pass

## Learn
- bite: none
`;
  writeFileSync(join(forge, "reviews", `${id}.md`), body, "utf8");
}

function writeUxReview(mona: string, id: string, verdict: string, theater = false): void {
  mkdirSync(join(mona, "reviews"), { recursive: true });
  writeFileSync(join(mona, "AGENTS.md"), "# mona\n", "utf8");
  const body = theater
    ? `# UX ${id}\n\npretty.\n`
    : `# UX ${id}

Verdict: ${verdict}
`;
  writeFileSync(join(mona, "reviews", `${id}-ux.md`), body, "utf8");
}

function writeSpec(dir: string, name = "UX_SPEC.md"): string {
  const path = join(dir, name);
  writeFileSync(path, "# HUD\nscreens: one\n", "utf8");
  return path;
}

async function seedUx(input: {
  label: string;
  ticketId: string;
  waveId: string;
  needsUx?: boolean;
  planReviewSkip?: boolean;
  humanHold?: boolean;
  uxSpecPath?: string;
  uxReviewReviseCap?: number;
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
    needsUx: input.needsUx,
    uxSpecPath: input.uxSpecPath,
    uxReviewReviseCap: input.uxReviewReviseCap,
    humanHold: input.humanHold,
    humanHoldReason: input.humanHold ? "needs_jason" : undefined,
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

test("resolveNeedsUx: yaml/json only, not heuristics", () => {
  assert.equal(resolveNeedsUx({ needs_ux: true }), true);
  assert.equal(resolveNeedsUx({ needsUx: true }), true);
  assert.equal(resolveNeedsUx({ ux_review: "required" }), true);
  assert.equal(resolveNeedsUx({ uxReview: "required" }), true);
  assert.equal(resolveNeedsUx({ labels: ["ux", "mona"] }), false);
  assert.equal(resolveNeedsUx({ assignee: "mona" }), false);
  assert.equal(resolveNeedsUx({ planClass: "manual" }), false);
  assert.equal(resolveNeedsUx({}), false);
});

test("checkUxReview: verdict only, no cheat-mode/Learn required", () => {
  const mona = mkdtempSync(join(tmpdir(), "wr037-ux-"));
  writeUxReview(mona, "UX-001", "approve");
  const ok = checkUxReview({ monaRoot: mona, ticketId: "UX-001" });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.verdict, "approve");
  writeUxReview(mona, "UX-002", "approve", true);
  assert.equal(checkUxReview({ monaRoot: mona, ticketId: "UX-002" }).ok, false);
});

test("resolveMonaWorkspace: explicit / MONA_ROOT / default AGENTS.md", () => {
  const mona = mkdtempSync(join(tmpdir(), "wr037-mona-"));
  writeFileSync(join(mona, "AGENTS.md"), "# mona\n", "utf8");
  assert.equal(resolveMonaWorkspace({ explicit: mona, env: {} }), mona);
  assert.equal(resolveMonaWorkspace({ env: { MONA_ROOT: mona } }), mona);
  const missing = join(mona, "no-such-mona");
  const resolved = resolveMonaWorkspace({ env: { MONA_ROOT: missing } });
  assert.notEqual(resolved, missing);
  if (resolved) assert.ok(existsSync(join(resolved, "AGENTS.md")));
});

test("no needs_ux: PLAN → Crawmak → ledger-approve → IMPL; no UX_REVIEW", async () => {
  const forge = mkdtempSync(join(tmpdir(), "wr037-noux-"));
  writeReview(forge, "NU-001", "approve");
  const { sim, controller } = await seedUx({
    label: "wr037-noux",
    ticketId: "NU-001",
    waveId: "wave-noux",
    forge,
  });
  await controller.start("wave-noux");
  await controller.runUntilIdle("wave-noux");
  const view = controller.inspect("wave-noux");
  assert.equal(view.tickets[0]?.status, "DONE");
  assert.ok(sim.worker.intents.some((i) => i.stage === "REVIEW"));
  assert.ok(sim.worker.intents.some((i) => i.stage === "IMPL"));
  assert.ok(sim.worker.intents.every((i) => i.stage !== "UX_REVIEW"));
  assert.ok(view.events.some((e) => e.type === "plan_review_admit"));
});

test("needs_ux: after Crawmak approve-class launch UX_REVIEW; stay gated; no IMPL", async () => {
  const forge = mkdtempSync(join(tmpdir(), "wr037-gate-"));
  const mona = mkdtempSync(join(tmpdir(), "wr037-mona-"));
  const spec = writeSpec(mona);
  writeReview(forge, "UX-010", "approve");
  writeFileSync(join(mona, "AGENTS.md"), "# mona\n", "utf8");
  const { sim, controller } = await seedUx({
    label: "wr037-gate",
    ticketId: "UX-010",
    waveId: "wave-gate",
    needsUx: true,
    uxSpecPath: spec,
    forge,
    mona,
  });
  await controller.start("wave-gate");
  await controller.runUntilIdle("wave-gate");
  const view = controller.inspect("wave-gate");
  assert.equal(view.wave.status, "AWAITING_PLAN_GATE");
  assert.equal(view.tickets[0]?.status, "PLAN_REVIEW");
  assert.ok(sim.worker.intents.some((i) => i.stage === "REVIEW"));
  assert.ok(sim.worker.intents.some((i) => i.stage === "UX_REVIEW"));
  assert.ok(sim.worker.intents.every((i) => i.stage !== "IMPL"));
  assert.ok(!view.events.some((e) => e.type === "plan_review_admit"));
  assert.ok(!view.events.some((e) => e.type === "ux_review_admit"));
});

test("UX_REVIEW cwd is Mona workspace; agentId mona; REVIEW stays grok", async () => {
  const forge = mkdtempSync(join(tmpdir(), "wr037-cwd-"));
  const mona = mkdtempSync(join(tmpdir(), "wr037-cwdm-"));
  const spec = writeSpec(mona);
  writeReview(forge, "UX-011", "approve");
  writeFileSync(join(mona, "AGENTS.md"), "# mona\n", "utf8");
  const { sim, controller } = await seedUx({
    label: "wr037-cwd",
    ticketId: "UX-011",
    waveId: "wave-cwd",
    needsUx: true,
    uxSpecPath: spec,
    forge,
    mona,
  });
  await controller.start("wave-cwd");
  await controller.runUntilIdle("wave-cwd");
  const review = sim.worker.intents.find((i) => i.stage === "REVIEW");
  const ux = sim.worker.intents.find((i) => i.stage === "UX_REVIEW");
  assert.equal(review?.worktree, forge);
  assert.equal(review?.agentId, "grok");
  assert.equal(ux?.worktree, mona);
  assert.equal(ux?.agentId, "mona");
  assert.ok(!ux?.worktree?.includes("worktrees"));
});

test("Mona revise → REVISING, not IMPL; cap 1 → ux_review_revise_cap", async () => {
  const forge = mkdtempSync(join(tmpdir(), "wr037-rev-"));
  const mona = mkdtempSync(join(tmpdir(), "wr037-revm-"));
  const spec = writeSpec(mona);
  writeReview(forge, "UX-012", "approve");
  writeUxReview(mona, "UX-012", "revise");
  const { sim, controller } = await seedUx({
    label: "wr037-rev",
    ticketId: "UX-012",
    waveId: "wave-rev",
    needsUx: true,
    uxSpecPath: spec,
    forge,
    mona,
  });
  await controller.start("wave-rev");
  for (let i = 0; i < 16; i += 1) {
    if (controller.inspect("wave-rev").events.some((e) => e.type === "ux_review_revise")) break;
    await controller.tick("wave-rev");
  }
  assert.ok(controller.inspect("wave-rev").events.some((e) => e.type === "ux_review_revise"));
  assert.ok(sim.worker.intents.every((i) => i.stage !== "IMPL"));
  await controller.runUntilIdle("wave-rev");
  const view = controller.inspect("wave-rev");
  assert.equal(view.tickets[0]?.status, "FAILED");
  assert.equal(view.tickets[0]?.result, "ux_review_revise_cap");
});

test("post-UX-revise re-review is revision-keyed; stale Crawmak file does not admit", async () => {
  const forge = mkdtempSync(join(tmpdir(), "wr037-hop-"));
  const mona = mkdtempSync(join(tmpdir(), "wr037-hopm-"));
  const spec = writeSpec(mona);
  writeReview(forge, "UX-013", "approve");
  writeUxReview(mona, "UX-013", "revise");
  const { sim, controller } = await seedUx({
    label: "wr037-hop",
    ticketId: "UX-013",
    waveId: "wave-hop",
    needsUx: true,
    uxSpecPath: spec,
    forge,
    mona,
  });
  await controller.start("wave-hop");
  for (let i = 0; i < 16; i += 1) {
    if (controller.inspect("wave-hop").events.some((e) => e.type === "ux_review_revise")) break;
    await controller.tick("wave-hop");
  }
  writeUxReview(mona, "UX-013", "approve", true);
  await controller.runUntilIdle("wave-hop");
  const reviews = sim.worker.intents.filter((i) => i.stage === "REVIEW");
  const uxs = sim.worker.intents.filter((i) => i.stage === "UX_REVIEW");
  assert.ok(reviews.length >= 2);
  assert.ok(uxs.length >= 2);
  const view = controller.inspect("wave-hop");
  assert.equal(view.tickets[0]?.status, "PLAN_REVIEW");
  assert.ok(sim.worker.intents.every((i) => i.stage !== "IMPL"));
  assert.ok(!view.events.some((e) => e.type === "ux_review_admit"));
});

test("Mona approve without Crawmak approve-class stays PLAN_REVIEW", async () => {
  const forge = mkdtempSync(join(tmpdir(), "wr037-nocraw-"));
  const mona = mkdtempSync(join(tmpdir(), "wr037-nocrawm-"));
  const spec = writeSpec(mona);
  writeReview(forge, "UX-014", "approve", true);
  writeUxReview(mona, "UX-014", "approve");
  const { sim, controller } = await seedUx({
    label: "wr037-nocraw",
    ticketId: "UX-014",
    waveId: "wave-nocraw",
    needsUx: true,
    uxSpecPath: spec,
    forge,
    mona,
  });
  await controller.start("wave-nocraw");
  await controller.runUntilIdle("wave-nocraw");
  const view = controller.inspect("wave-nocraw");
  assert.equal(view.tickets[0]?.status, "PLAN_REVIEW");
  assert.ok(sim.worker.intents.every((i) => i.stage !== "UX_REVIEW"));
  assert.ok(sim.worker.intents.every((i) => i.stage !== "IMPL"));
});

test("Mona approve + Crawmak approve-class ledger-approves without Astra/Jason stamp", async () => {
  const forge = mkdtempSync(join(tmpdir(), "wr037-ok-"));
  const mona = mkdtempSync(join(tmpdir(), "wr037-okm-"));
  const spec = writeSpec(mona);
  writeReview(forge, "UX-015", "approve");
  writeUxReview(mona, "UX-015", "approve");
  const { sim, controller } = await seedUx({
    label: "wr037-ok",
    ticketId: "UX-015",
    waveId: "wave-ok",
    needsUx: true,
    uxSpecPath: spec,
    forge,
    mona,
  });
  await controller.start("wave-ok");
  await controller.runUntilIdle("wave-ok");
  const view = controller.inspect("wave-ok");
  assert.equal(view.tickets[0]?.status, "DONE");
  assert.ok(sim.worker.intents.some((i) => i.stage === "IMPL"));
  assert.ok(view.events.some((e) => e.type === "ux_review_admit"));
  assert.ok(!view.events.some((e) => e.type === "plan_review_admit"));
});

test("leftover stamp + needs_ux + no Mona is not admitted", async () => {
  const forge = mkdtempSync(join(tmpdir(), "wr037-stamp-"));
  const mona = mkdtempSync(join(tmpdir(), "wr037-stampm-"));
  const spec = writeSpec(mona);
  writeReview(forge, "UX-016", "approve");
  writeFileSync(join(mona, "AGENTS.md"), "# mona\n", "utf8");
  const { sim, controller } = await seedUx({
    label: "wr037-stamp",
    ticketId: "UX-016",
    waveId: "wave-stamp",
    needsUx: true,
    uxSpecPath: spec,
    forge,
    mona,
  });
  await controller.start("wave-stamp");
  await controller.runUntilIdle("wave-stamp");
  const plan = controller.inspect("wave-stamp").tickets[0]?.planArtifact;
  assert.ok(plan);
  writeFileSync(plan, `${plan}\nAPPROVED by Jason\n`, "utf8");
  await controller.runUntilIdle("wave-stamp");
  const view = controller.inspect("wave-stamp");
  assert.equal(view.tickets[0]?.status, "PLAN_REVIEW");
  assert.ok(sim.worker.intents.every((i) => i.stage !== "IMPL"));
});

test("human hold: WAITING_APPROVAL; no REVIEW; no UX_REVIEW", async () => {
  const { sim, controller } = await seedUx({
    label: "wr037-hold",
    ticketId: "UX-017",
    waveId: "wave-hold",
    needsUx: true,
    humanHold: true,
    planReviewSkip: false,
  });
  await controller.start("wave-hold");
  await controller.runUntilIdle("wave-hold");
  assert.equal(controller.inspect("wave-hold").wave.status, "WAITING_APPROVAL");
  assert.ok(sim.worker.intents.every((i) => i.stage !== "REVIEW"));
  assert.ok(sim.worker.intents.every((i) => i.stage !== "UX_REVIEW"));
});

test("plan_review skip + needs_ux: no Crawmak; no plan_gate_auto; still UX_REVIEW then IMPL", async () => {
  const mona = mkdtempSync(join(tmpdir(), "wr037-skip-"));
  const spec = writeSpec(mona);
  writeUxReview(mona, "UX-018", "approve");
  const { sim, controller } = await seedUx({
    label: "wr037-skip",
    ticketId: "UX-018",
    waveId: "wave-skip",
    needsUx: true,
    planReviewSkip: true,
    uxSpecPath: spec,
    mona,
  });
  await controller.start("wave-skip");
  await controller.runUntilIdle("wave-skip");
  const view = controller.inspect("wave-skip");
  assert.equal(view.tickets[0]?.status, "DONE");
  assert.ok(sim.worker.intents.every((i) => i.stage !== "REVIEW"));
  assert.ok(sim.worker.intents.some((i) => i.stage === "UX_REVIEW"));
  assert.ok(sim.worker.intents.some((i) => i.stage === "IMPL"));
  assert.ok(!view.events.some((e) => e.type === "plan_gate_auto"));
});

test("needs_ux PLAN missing UX spec: missing_ux_spec; no Mona; no IMPL", async () => {
  const forge = mkdtempSync(join(tmpdir(), "wr037-spec-"));
  const mona = mkdtempSync(join(tmpdir(), "wr037-specm-"));
  writeReview(forge, "UX-019", "approve");
  writeFileSync(join(mona, "AGENTS.md"), "# mona\n", "utf8");
  const { sim, controller } = await seedUx({
    label: "wr037-spec",
    ticketId: "UX-019",
    waveId: "wave-spec",
    needsUx: true,
    forge,
    mona,
  });
  await controller.start("wave-spec");
  await controller.runUntilIdle("wave-spec");
  const view = controller.inspect("wave-spec");
  assert.equal(view.tickets[0]?.status, "PLAN_REVIEW");
  assert.equal(view.tickets[0]?.result, "missing_ux_spec");
  assert.ok(sim.worker.intents.every((i) => i.stage !== "UX_REVIEW"));
  assert.ok(sim.worker.intents.every((i) => i.stage !== "IMPL"));
});

test("theater / missing Mona Verdict stays PLAN_REVIEW", async () => {
  const forge = mkdtempSync(join(tmpdir(), "wr037-th-"));
  const mona = mkdtempSync(join(tmpdir(), "wr037-thm-"));
  const spec = writeSpec(mona);
  writeReview(forge, "UX-020", "approve");
  writeUxReview(mona, "UX-020", "approve", true);
  const { sim, controller } = await seedUx({
    label: "wr037-th",
    ticketId: "UX-020",
    waveId: "wave-th",
    needsUx: true,
    uxSpecPath: spec,
    forge,
    mona,
  });
  await controller.start("wave-th");
  await controller.runUntilIdle("wave-th");
  assert.equal(controller.inspect("wave-th").tickets[0]?.status, "PLAN_REVIEW");
  assert.ok(sim.worker.intents.every((i) => i.stage !== "IMPL"));
});

test("parseStageFromIdempotencyKey / inspectReceiptArtifacts keep UX_REVIEW", () => {
  const parsed = parseStageFromIdempotencyKey("BL-W:T:UX_REVIEW:1");
  assert.equal(parsed.stage, "UX_REVIEW");
  const dir = mkdtempSync(join(tmpdir(), "wr037-term-"));
  const key = "BL-W-x:T:UX_REVIEW:1";
  writeStageTerminal(dir, {
    idempotencyKey: key,
    waveId: "BL-W-x",
    ticketId: "T",
    stage: "UX_REVIEW",
    attempt: 1,
    status: "succeeded",
    artifact: "terminal.json",
  });
  const truth = inspectReceiptArtifacts({ idempotencyKey: key, outputDir: dir });
  assert.equal(truth?.status, "succeeded");
});

test("Grok-cli fallback refuses UX_REVIEW", async () => {
  const worker = new GrokCliWorker({ repoPath: "/tmp", launcherPath: "/bin/true" });
  const intent: LaunchIntent = {
    idempotencyKey: "w:T:UX_REVIEW:1",
    waveId: "w",
    ticketId: "T",
    stage: "UX_REVIEW",
    attempt: 1,
    prompt: "ux",
    sessionKey: "s",
  };
  await assert.rejects(() => worker.launch(intent), /refuses UX_REVIEW/);
  const inspect = await worker.inspect({ idempotencyKey: "w:T:UX_REVIEW:1" });
  assert.equal(inspect.status, "failed");
});

test("IMPL brief for needs_ux contains spec path and no-invent contract", async () => {
  const forge = mkdtempSync(join(tmpdir(), "wr037-impl-"));
  const mona = mkdtempSync(join(tmpdir(), "wr037-implm-"));
  const spec = writeSpec(mona);
  writeReview(forge, "UX-021", "approve");
  writeUxReview(mona, "UX-021", "approve");
  const { sim, controller } = await seedUx({
    label: "wr037-impl",
    ticketId: "UX-021",
    waveId: "wave-impl",
    needsUx: true,
    uxSpecPath: spec,
    forge,
    mona,
  });
  await controller.start("wave-impl");
  await controller.runUntilIdle("wave-impl");
  const impl = sim.worker.intents.find((i) => i.stage === "IMPL");
  assert.ok(impl);
  assert.match(impl.prompt, new RegExp(`UX spec: ${spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(impl.prompt, /Do not invent HUD\/UX/);
});

test("markdown freeze: needs_ux / ux_review required; not labels", () => {
  const root = mkdtempSync(join(tmpdir(), "wr037-md-"));
  const path = join(root, "issues", "MD-001.md");
  mkdirSync(join(root, "issues"), { recursive: true });
  writeFileSync(
    path,
    `---
id: MD-001
title: ux
verify: "true"
needs_ux: true
ux_spec: docs/ux.md
labels: [engine]
assignee: mona
---
body
`,
    "utf8",
  );
  const parsed = parseTicketFile(path, root);
  assert.equal(parsed?.needsUx, true);
  assert.equal(parsed?.uxSpecPath, "docs/ux.md");
});

test("GrokAcpWorker UX_REVIEW spawn uses agentId mona; REVIEW uses grok", async () => {
  const root = mkdtempSync(join(tmpdir(), "wr037-acp-"));
  const spawned: Array<{ agentId: string; cwd?: string }> = [];
  const acp: AcpSpawn = {
    async spawn(request) {
      spawned.push({ agentId: request.agentId, cwd: request.cwd });
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
  await worker.launch({
    idempotencyKey: "w:T:REVIEW:1",
    waveId: "w",
    ticketId: "T",
    stage: "REVIEW",
    attempt: 1,
    prompt: "review",
    sessionKey: "sk-r",
    worktree: root,
    outputDir: join(root, "review"),
  });
  await worker.launch({
    idempotencyKey: "w:T:UX_REVIEW:1",
    waveId: "w",
    ticketId: "T",
    stage: "UX_REVIEW",
    attempt: 1,
    prompt: "ux",
    sessionKey: "sk-u",
    worktree: root,
    outputDir: join(root, "ux"),
    agentId: "mona",
    uxSpecPath: writeSpec(root),
  });
  assert.equal(spawned[0]?.agentId, "grok");
  assert.equal(spawned[1]?.agentId, "mona");
});
