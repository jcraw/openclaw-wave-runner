import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_LIMITS } from "../src/domain/types.js";
import { createSimulator, seedWave } from "../src/sim/simulator.js";

function writeReview(forge: string, id: string, verdict: string): void {
  mkdirSync(join(forge, "reviews"), { recursive: true });
  writeFileSync(join(forge, "AGENTS.md"), "# forge\n", "utf8");
  writeFileSync(
    join(forge, "reviews", `${id}.md`),
    `# REVIEW ${id}

Verdict: ${verdict}

## Cheat-mode scan
- test-weaken: pass
- fake-verify: pass
- scope: pass
- self-stamp: pass
- review-theater: pass

## Learn
- bite: none
`,
    "utf8",
  );
}

function stampPlan(path: string | undefined, who = "Jason"): void {
  assert.ok(path);
  writeFileSync(path, `${readFileSync(path, "utf8")}\nAPPROVED by ${who}\n`, "utf8");
}

async function seedReview(input: { label: string; ticketId: string; waveId: string; forge?: string }) {
  const sim = createSimulator(input.label);
  sim.tracker.seed({
    ticketId: input.ticketId,
    title: input.ticketId,
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: `issues/${input.ticketId}.md`,
    verifyCommand: "true",
    planReviewSkip: false,
    body: input.ticketId,
  });
  const controller = await seedWave(sim, input.waveId, [input.ticketId], {
    maxTokens: 80_000,
    maxLaunches: 12,
  });
  if (input.forge) Object.assign(controller, { forgeRoot: input.forge });
  return { sim, controller };
}

async function waitFor(controller: Awaited<ReturnType<typeof seedWave>>, waveId: string, pred: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (pred()) return;
    await controller.tick(waveId);
  }
}

function review2(view: { outbox: Array<{ idempotencyKey: string; state: string }> }) {
  return view.outbox.find((item) => item.idempotencyKey.includes(":REVIEW:2"));
}

test("in-flight REVIEW 2 does not fail-close on hop-1 Verdict revise", async () => {
  const ticketId = "RV-038A";
  const waveId = "wave-stale-inflight";
  const forge = mkdtempSync(join(tmpdir(), "wr038-inflight-"));
  writeReview(forge, ticketId, "revise");
  const { sim, controller } = await seedReview({
    label: "wr038-inflight",
    ticketId,
    waveId,
    forge,
  });
  sim.worker.hangPrefix = ":REVIEW:2";
  await controller.start(waveId);
  await waitFor(controller, waveId, () =>
    controller.inspect(waveId).events.some((e) => e.type === "plan_review_revise"),
  );
  await waitFor(controller, waveId, () => {
    const item = review2(controller.inspect(waveId));
    return item?.state === "LAUNCHED" || item?.state === "CLAIMED";
  });
  for (let i = 0; i < 8; i += 1) await controller.tick(waveId);
  const view = controller.inspect(waveId);
  assert.equal(view.tickets[0]?.status, "PLAN_REVIEW");
  assert.notEqual(view.tickets[0]?.result, "plan_review_revise_cap");
  assert.equal(view.events.filter((e) => e.type === "plan_review_revise").length, 1);
  assert.ok(sim.worker.intents.every((i) => i.stage !== "IMPL"));
  assert.ok(!["COMPLETED", "FAILED", "BLOCKED", "BUDGET_STOPPED", "CANCELLED"].includes(view.wave.status));
  const item = review2(view);
  assert.ok(item);
  assert.ok(item.state === "LAUNCHED" || item.state === "CLAIMED");
});

test("hop-2 approve-class admits after REVIEW 2 settles", async () => {
  const ticketId = "RV-038B";
  const waveId = "wave-hop2-approve";
  const forge = mkdtempSync(join(tmpdir(), "wr038-approve-"));
  writeReview(forge, ticketId, "revise");
  const { sim, controller } = await seedReview({
    label: "wr038-approve",
    ticketId,
    waveId,
    forge,
  });
  sim.worker.hangPrefix = ":REVIEW:2";
  await controller.start(waveId);
  await waitFor(controller, waveId, () =>
    controller.inspect(waveId).events.some((e) => e.type === "plan_review_revise"),
  );
  await waitFor(controller, waveId, () => {
    const item = review2(controller.inspect(waveId));
    return item?.state === "LAUNCHED" || item?.state === "CLAIMED";
  });
  writeReview(forge, ticketId, "approve");
  sim.worker.hangPrefix = undefined;
  await controller.runUntilIdle(waveId);
  const view = controller.inspect(waveId);
  assert.ok(view.tickets[0]?.status === "DONE" || view.tickets[0]?.status === "APPROVED");
  assert.ok(view.events.some((e) => e.type === "plan_review_admit"));
  assert.ok(!view.events.some((e) => e.type === "plan_review_revise_cap"));
  assert.notEqual(view.tickets[0]?.result, "plan_review_revise_cap");
});

test("real second revise after REVIEW 2 succeeds hits plan_review_revise_cap", async () => {
  const ticketId = "RV-038C";
  const waveId = "wave-second-revise";
  const forge = mkdtempSync(join(tmpdir(), "wr038-cap-"));
  writeReview(forge, ticketId, "revise");
  const { sim, controller } = await seedReview({
    label: "wr038-cap",
    ticketId,
    waveId,
    forge,
  });
  await controller.start(waveId);
  await controller.runUntilIdle(waveId);
  const view = controller.inspect(waveId);
  assert.equal(view.tickets[0]?.status, "FAILED");
  assert.equal(view.tickets[0]?.result, "plan_review_revise_cap");
  assert.ok(view.events.some((e) => e.type === "plan_review_revise"));
  assert.ok(sim.worker.intents.every((i) => i.stage !== "IMPL"));
  assert.ok(sim.worker.intents.some((i) => i.stage === "REVIEW" && i.idempotencyKey.includes(":REVIEW:2")));
});

test("leftover Jason stamp with no Crawmak launch still admits", async () => {
  const ticketId = "RV-038D";
  const waveId = "wave-leftover-stamp";
  const prevForge = process.env.CRAWMAK_FORGE;
  delete process.env.CRAWMAK_FORGE;
  try {
    const sim = createSimulator("wr038-leftover");
    sim.tracker.seed({
      ticketId,
      title: ticketId,
      contentHash: "",
      dependsOn: [],
      order: 1,
      sourcePath: `issues/${ticketId}.md`,
      verifyCommand: "true",
      planReviewSkip: false,
      body: ticketId,
    });
    const controller = sim.open();
    await controller.create({
      waveId,
      repoPath: join(mkdtempSync(join(tmpdir(), "wr038-repo-")), "product"),
      ticketIds: [ticketId],
      limits: { ...DEFAULT_LIMITS, maxTokens: 80_000, maxLaunches: 12 },
    });
    await controller.start(waveId);
    await waitFor(controller, waveId, () => {
      const t = controller.inspect(waveId).tickets[0];
      return t?.status === "PLAN_REVIEW" && Boolean(t.planArtifact);
    });
    stampPlan(controller.inspect(waveId).tickets[0]?.planArtifact, "Jason");
    await controller.runUntilIdle(waveId);
    const view = controller.inspect(waveId);
    assert.equal(view.tickets[0]?.status, "DONE");
    const admit = view.events.find((e) => e.type === "plan_review_admit");
    assert.ok(admit);
    assert.equal(JSON.parse(admit.payloadJson).leftover, true);
    assert.ok(sim.worker.intents.every((i) => i.stage !== "REVIEW"));
    assert.ok(!view.events.some((e) => e.type === "plan_review_launch"));
  } finally {
    if (prevForge === undefined) delete process.env.CRAWMAK_FORGE;
    else process.env.CRAWMAK_FORGE = prevForge;
  }
});
