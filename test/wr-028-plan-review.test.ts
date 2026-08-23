import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { resolvePlanReviewSkip } from "../src/core/plan-review-skip.js";
import { checkPlanReview, checkPlanStamp } from "../src/core/plan-review.js";
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
- fake-verify: pass
- scope: pass
- self-stamp: pass
- review-theater: pass

## Learn
- bite: none
`;
  writeFileSync(join(forge, "reviews", `${id}.md`), body, "utf8");
}

function stampPlan(path: string | undefined, who = "Jason"): void {
  assert.ok(path);
  writeFileSync(path, `${readFileSync(path, "utf8")}\nAPPROVED by ${who}\n`, "utf8");
}

test("resolvePlanReviewSkip: yaml only, not heuristics", () => {
  assert.equal(resolvePlanReviewSkip({ plan_review: "skip" }), true);
  assert.equal(resolvePlanReviewSkip({ review: "skip" }), true);
  assert.equal(resolvePlanReviewSkip({ review_skip: true }), true);
  assert.equal(resolvePlanReviewSkip({ jason_skip: "true" }), true);
  assert.equal(resolvePlanReviewSkip({ review: "true" }), false);
  assert.equal(resolvePlanReviewSkip({ verify: "true" }), false);
  assert.equal(resolvePlanReviewSkip({ planClass: "safe-policy" }), false);
  assert.equal(resolvePlanReviewSkip({}), false);
});

test("checkPlanReview + checkPlanStamp", () => {
  const forge = mkdtempSync(join(tmpdir(), "wr028-rev-"));
  writeReview(forge, "AA-001", "approve");
  const ok = checkPlanReview({ forgeRoot: forge, ticketId: "AA-001" });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.verdict, "approve");
  const missing = checkPlanReview({ forgeRoot: forge, ticketId: "NOPE" });
  assert.equal(missing.ok, false);
  writeReview(forge, "AA-002", "approve", true);
  assert.equal(checkPlanReview({ forgeRoot: forge, ticketId: "AA-002" }).ok, false);
  assert.equal(checkPlanStamp("APPROVED by Jason\n"), true);
  assert.equal(checkPlanStamp("APPROVED by Astra"), true);
  assert.equal(checkPlanStamp("looks good"), false);
});

test("skip-bit ticket: PLAN artifact → plan_gate_auto → DONE", async () => {
  const sim = createSimulator("wr028-skip");
  const controller = await seedWave(sim, "wave-skip", ["FX-001"], {
    ...DEFAULT_LIMITS,
    maxTokens: 80_000,
    maxLaunches: 8,
  });
  await controller.start("wave-skip");
  await controller.runUntilIdle("wave-skip");
  const view = controller.inspect("wave-skip");
  assert.notEqual(view.wave.status, "AWAITING_PLAN_GATE");
  assert.equal(view.tickets[0]?.status, "DONE");
  assert.ok(view.events.some((e) => e.type === "plan_gate_auto"));
  assert.equal(sim.worker.intents.filter((i) => i.stage === "REVIEW").length, 0);
});

test("default no skip: PLAN → PLAN_REVIEW + REVIEW launch; no IMPL; no plan_gate_auto", async () => {
  const forge = mkdtempSync(join(tmpdir(), "wr028-forge-"));
  writeFileSync(join(forge, "AGENTS.md"), "# forge\n", "utf8");
  const sim = createSimulator("wr028-default");
  sim.tracker.seed({
    ticketId: "RV-001",
    title: "review me",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/RV-001.md",
    planClass: "manual",
    verifyCommand: "true",
    planReviewSkip: false,
    body: "review me",
  });
  const controller = await seedWave(sim, "wave-rv", ["RV-001"], {
    maxTokens: 80_000,
    maxLaunches: 8,
  });
  Object.assign(controller, { forgeRoot: forge });
  await controller.start("wave-rv");
  await controller.runUntilIdle("wave-rv");
  const view = controller.inspect("wave-rv");
  assert.equal(view.wave.status, "AWAITING_PLAN_GATE");
  assert.equal(view.tickets[0]?.status, "PLAN_REVIEW");
  assert.ok(sim.worker.intents.some((i) => i.stage === "REVIEW"));
  assert.ok(sim.worker.intents.every((i) => i.stage !== "IMPL"));
  assert.equal(view.events.filter((e) => e.type === "plan_gate_auto").length, 0);
  const reviewIntent = sim.worker.intents.find((i) => i.stage === "REVIEW");
  assert.equal(reviewIntent?.worktree, forge);
});

test("REVIEW cwd is forge not product worktree", async () => {
  const forge = mkdtempSync(join(tmpdir(), "wr028-cwd-"));
  writeFileSync(join(forge, "AGENTS.md"), "# forge\n", "utf8");
  const sim = createSimulator("wr028-cwd");
  sim.tracker.seed({
    ticketId: "RV-002",
    title: "cwd",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/RV-002.md",
    verifyCommand: "true",
    planReviewSkip: false,
    body: "cwd",
  });
  const controller = await seedWave(sim, "wave-cwd", ["RV-002"], { maxTokens: 80_000, maxLaunches: 8 });
  Object.assign(controller, { forgeRoot: forge });
  await controller.start("wave-cwd");
  await controller.runUntilIdle("wave-cwd");
  const intent = sim.worker.intents.find((i) => i.stage === "REVIEW");
  assert.ok(intent);
  assert.equal(intent.worktree, forge);
  assert.ok(!intent.worktree?.includes("worktrees"));
});

test("verdict revise re-queues PLAN; not IMPL", async () => {
  const forge = mkdtempSync(join(tmpdir(), "wr028-rev-"));
  writeReview(forge, "RV-003", "revise");
  const sim = createSimulator("wr028-revise");
  sim.tracker.seed({
    ticketId: "RV-003",
    title: "revise",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/RV-003.md",
    verifyCommand: "true",
    planReviewSkip: false,
    body: "revise",
  });
  const controller = await seedWave(sim, "wave-revise", ["RV-003"], { maxTokens: 80_000, maxLaunches: 8 });
  Object.assign(controller, { forgeRoot: forge });
  await controller.start("wave-revise");
  for (let i = 0; i < 12; i += 1) {
    if (controller.inspect("wave-revise").events.some((e) => e.type === "plan_review_revise")) break;
    await controller.tick("wave-revise");
  }
  const view = controller.inspect("wave-revise");
  assert.ok(view.events.some((e) => e.type === "plan_review_revise"));
  assert.ok(sim.worker.intents.every((i) => i.stage !== "IMPL"));
  assert.ok(!view.events.some((e) => e.type === "plan_review_admit"));
});

test("approve without stamp stays PLAN_REVIEW", async () => {
  const forge = mkdtempSync(join(tmpdir(), "wr028-nostamp-"));
  writeReview(forge, "RV-004", "approve");
  const sim = createSimulator("wr028-nostamp");
  sim.tracker.seed({
    ticketId: "RV-004",
    title: "nostamp",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/RV-004.md",
    verifyCommand: "true",
    planReviewSkip: false,
    body: "nostamp",
  });
  const controller = await seedWave(sim, "wave-ns", ["RV-004"], { maxTokens: 80_000, maxLaunches: 8 });
  Object.assign(controller, { forgeRoot: forge });
  await controller.start("wave-ns");
  await controller.runUntilIdle("wave-ns");
  const view = controller.inspect("wave-ns");
  assert.equal(view.tickets[0]?.status, "PLAN_REVIEW");
  assert.equal(view.wave.status, "AWAITING_PLAN_GATE");
  assert.ok(sim.worker.intents.every((i) => i.stage !== "IMPL"));
});

test("approve + APPROVED by Jason on plan → IMPL/DONE", async () => {
  const forge = mkdtempSync(join(tmpdir(), "wr028-stamp-"));
  writeReview(forge, "RV-005", "approve");
  const sim = createSimulator("wr028-stamp");
  sim.tracker.seed({
    ticketId: "RV-005",
    title: "stamp",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/RV-005.md",
    verifyCommand: "true",
    planReviewSkip: false,
    body: "stamp",
  });
  const controller = await seedWave(sim, "wave-st", ["RV-005"], { maxTokens: 80_000, maxLaunches: 8 });
  Object.assign(controller, { forgeRoot: forge });
  await controller.start("wave-st");
  await controller.runUntilIdle("wave-st");
  stampPlan(controller.inspect("wave-st").tickets[0]?.planArtifact, "Jason");
  await controller.runUntilIdle("wave-st");
  const view = controller.inspect("wave-st");
  assert.equal(view.tickets[0]?.status, "DONE");
  assert.equal(view.wave.status, "COMPLETED");
  assert.ok(sim.worker.intents.some((i) => i.stage === "IMPL"));
  assert.ok(view.events.some((e) => e.type === "plan_review_admit"));
});

test("theater / missing Verdict stays PLAN_REVIEW", async () => {
  const forge = mkdtempSync(join(tmpdir(), "wr028-th-"));
  writeReview(forge, "RV-006", "approve", true);
  const sim = createSimulator("wr028-th");
  sim.tracker.seed({
    ticketId: "RV-006",
    title: "theater",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/RV-006.md",
    verifyCommand: "true",
    planReviewSkip: false,
    body: "theater",
  });
  const controller = await seedWave(sim, "wave-th", ["RV-006"], { maxTokens: 80_000, maxLaunches: 8 });
  Object.assign(controller, { forgeRoot: forge });
  await controller.start("wave-th");
  await controller.runUntilIdle("wave-th");
  assert.equal(controller.inspect("wave-th").tickets[0]?.status, "PLAN_REVIEW");
  assert.ok(sim.worker.intents.every((i) => i.stage !== "IMPL"));
});

test("human hold still WAITING_APPROVAL; pick is not a hold", async () => {
  const holdSim = createSimulator("wr028-hold");
  holdSim.tracker.seed({
    ticketId: "HX-028",
    title: "hold",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/HX-028.md",
    verifyCommand: "true",
    planReviewSkip: false,
    humanHold: true,
    humanHoldReason: "needs_jason",
    body: "hold",
  });
  const hold = await seedWave(holdSim, "wave-h", ["HX-028"], { maxTokens: 80_000, maxLaunches: 8 });
  await hold.start("wave-h");
  await hold.runUntilIdle("wave-h");
  assert.equal(hold.inspect("wave-h").wave.status, "WAITING_APPROVAL");
  assert.ok(holdSim.worker.intents.every((i) => i.stage !== "REVIEW"));
});

test("safe-policy without skip parks (D12)", async () => {
  const forge = mkdtempSync(join(tmpdir(), "wr028-safe-"));
  writeFileSync(join(forge, "AGENTS.md"), "# forge\n", "utf8");
  const sim = createSimulator("wr028-safe");
  sim.tracker.seed({
    ticketId: "SX-028",
    title: "safe no skip",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/SX-028.md",
    planClass: "safe-policy",
    verifyCommand: "true",
    planReviewSkip: false,
    body: "safe",
  });
  const controller = await seedWave(sim, "wave-safe-ns", ["SX-028"], { maxTokens: 80_000, maxLaunches: 8 });
  Object.assign(controller, { forgeRoot: forge });
  await controller.start("wave-safe-ns");
  await controller.runUntilIdle("wave-safe-ns");
  assert.equal(controller.inspect("wave-safe-ns").wave.status, "AWAITING_PLAN_GATE");
  assert.equal(controller.inspect("wave-safe-ns").events.filter((e) => e.type === "plan_gate_auto").length, 0);
});

test("AUTO_PLAN_GATE script does not invent Astra or blind-approve the gate", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const backlog = readFileSync(join(root, "scripts/run-backlog-wave.sh"), "utf8");
  const op = readFileSync(join(root, "scripts/wave-operator.sh"), "utf8");
  assert.doesNotMatch(backlog, /printf .*APPROVED by Astra/);
  assert.doesNotMatch(backlog, /wave-operator\.sh" approve/);
  assert.match(backlog, /waiting_review_or_stamp/);
  assert.doesNotMatch(op, /printf .*APPROVED by Astra/);
  assert.match(op, /waiting_review_or_stamp/);
});
