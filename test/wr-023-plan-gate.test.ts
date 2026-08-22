import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { selectEligibleTickets } from "../src/adapters/eligible-select.js";
import { GAME_JAM, eligibleForBoundedWave } from "../src/adapters/studio.js";
import { needsJasonIsHold, resolveHumanHold } from "../src/core/human-hold.js";
import { checkPlanArtifact } from "../src/core/plan-artifact.js";
import { DEFAULT_LIMITS } from "../src/domain/types.js";
import { createSimulator, seedWave } from "../src/sim/simulator.js";

test("needsJasonIsHold: boolean/true-like only; pick is not a hold", () => {
  assert.equal(needsJasonIsHold(true), true);
  assert.equal(needsJasonIsHold("true"), true);
  assert.equal(needsJasonIsHold("YES"), true);
  assert.equal(needsJasonIsHold("1"), true);
  assert.equal(needsJasonIsHold("hold"), true);
  assert.equal(needsJasonIsHold(false), false);
  assert.equal(needsJasonIsHold(""), false);
  assert.equal(needsJasonIsHold("false"), false);
  assert.equal(needsJasonIsHold("pick"), false);
  assert.equal(needsJasonIsHold("opinion"), false);
  assert.equal(needsJasonIsHold("review"), false);
  assert.deepEqual(resolveHumanHold({ needsJason: "pick" }), {});
  assert.deepEqual(resolveHumanHold({ needsJason: true }), {
    humanHold: true,
    humanHoldReason: "needs_jason",
  });
  assert.deepEqual(resolveHumanHold({ eligibility: "human_gated" }), {
    humanHold: true,
    humanHoldReason: "human_gated",
  });
});

test("checkPlanArtifact: tiny, blocked, missing verify, ok fixture", () => {
  assert.equal(checkPlanArtifact({ planText: "short", ticketId: "FX-001" }).ok, false);
  const blocked = checkPlanArtifact({
    planText: "# BLOCKED\n\nNeed a human.\n\nmore text here for length",
    ticketId: "FX-001",
    verifyCommand: "true",
  });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.match(blocked.reason, /BLOCKED/);
  const missingId = checkPlanArtifact({
    planText: "# PLAN some other ticket\n\nA reasonably long plan body.",
    ticketId: "FX-001",
    verifyCommand: "true",
  });
  assert.equal(missingId.ok, false);
  const missingVerify = checkPlanArtifact({
    planText: "# PLAN FX-001\n\nDo the work without naming verify.",
    ticketId: "FX-001",
    verifyCommand: "./tools/verify_mud.sh --core",
  });
  assert.equal(missingVerify.ok, false);
  if (!missingVerify.ok) assert.match(missingVerify.reason, /verify/);
  const ok = checkPlanArtifact({
    planText: "# PLAN FX-001\n\nclass: manual\nverify: true\n",
    ticketId: "FX-001",
    verifyCommand: "true",
  });
  assert.equal(ok.ok, true);
  const live = checkPlanArtifact({
    planText: "# PLAN MUD-039\n\nRun ./tools/verify_mud.sh --core at closeout.\n",
    ticketId: "MUD-039",
    verifyCommand: "./tools/verify_mud.sh --core",
  });
  assert.equal(live.ok, true);
});

test("eligibleForBoundedWave: pick is eligible; true is not", () => {
  const pick = eligibleForBoundedWave(
    "---\nid: GJ-1\nstatus: open\nagent_eligible: true\nneeds_jason: pick\n---\n",
    GAME_JAM,
  );
  assert.equal(pick.eligible, true);
  const hold = eligibleForBoundedWave(
    "---\nid: GJ-1\nstatus: open\nneeds_jason: true\n---\n",
    GAME_JAM,
  );
  assert.equal(hold.eligible, false);
  assert.equal(hold.reason, "needs_jason");
});

function writeTicket(root: string, id: string, extra: string): void {
  mkdirSync(join(root, "issues"), { recursive: true });
  writeFileSync(
    join(root, "issues", `${id}.md`),
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

test("selectEligibleTickets: skip boolean hold; keep pick", () => {
  const root = mkdtempSync(join(tmpdir(), "wr023-select-"));
  writeTicket(root, "AA-001", `verify: "true"\nneeds_jason: pick`);
  writeTicket(root, "AA-002", `verify: "true"\nneeds_jason: true`);
  const result = selectEligibleTickets(root);
  assert.ok(result.eligible.includes("AA-001"));
  assert.ok(!result.eligible.includes("AA-002"));
  const skip = result.skipped.find((s) => s.ticketId === "AA-002");
  assert.ok(skip);
  assert.match(skip.reason, /needs_jason/);
});

test("selectEligibleTickets: plan_review and planning stay eligible", () => {
  const root = mkdtempSync(join(tmpdir(), "wr029-select-"));
  writeTicket(root, "RRT-062", `verify: "true"\nstatus: plan_review`);
  writeTicket(root, "RRT-063", `verify: "true"\nstatus: planning`);
  writeTicket(root, "RRT-064", `verify: "true"\nstatus: blocked`);
  const result = selectEligibleTickets(root);
  assert.ok(result.eligible.includes("RRT-062"));
  assert.ok(result.eligible.includes("RRT-063"));
  assert.ok(!result.eligible.includes("RRT-064"));
});

test("agent PLAN auto-approves and reaches DONE without approve()", async () => {
  const sim = createSimulator("wr023-auto");
  const controller = await seedWave(sim, "wave-auto", ["FX-001"], {
    ...DEFAULT_LIMITS,
    maxTokens: 80_000,
    maxLaunches: 8,
  });
  await controller.start("wave-auto");
  await controller.runUntilIdle("wave-auto");
  const view = controller.inspect("wave-auto");
  assert.notEqual(view.wave.status, "AWAITING_PLAN_GATE");
  assert.notEqual(view.wave.status, "WAITING_APPROVAL");
  const t = view.tickets.find((x) => x.ticketId === "FX-001")!;
  assert.equal(t.status, "DONE");
  assert.equal(view.events.filter((e) => e.type === "plan_gate_wake").length, 0);
  assert.ok(view.events.some((e) => e.type === "plan_gate_auto"));
});

test("human hold still parks; pick annotation on freeze does not", async () => {
  const holdSim = createSimulator("wr023-hold");
  holdSim.tracker.seed({
    ticketId: "HX-001",
    title: "hold",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/HX-001.md",
    planClass: "manual",
    verifyCommand: "true",
    humanHold: true,
    humanHoldReason: "needs_jason",
    body: "hold",
  });
  const hold = await seedWave(holdSim, "wave-hold", ["HX-001"], {
    maxTokens: 80_000,
    maxLaunches: 8,
  });
  await hold.start("wave-hold");
  await hold.runUntilIdle("wave-hold");
  assert.equal(hold.inspect("wave-hold").wave.status, "WAITING_APPROVAL");

  const pickSim = createSimulator("wr023-pick");
  pickSim.tracker.seed({
    ticketId: "PX-001",
    title: "pick later",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/PX-001.md",
    planClass: "manual",
    verifyCommand: "true",
    body: "needs_jason: pick is not a hold",
  });
  const pick = await seedWave(pickSim, "wave-pick", ["PX-001"], {
    maxTokens: 80_000,
    maxLaunches: 8,
  });
  await pick.start("wave-pick");
  await pick.runUntilIdle("wave-pick");
  assert.notEqual(pick.inspect("wave-pick").wave.status, "WAITING_APPROVAL");
  assert.equal(pick.inspect("wave-pick").tickets[0]?.status, "DONE");
});

test("blocked plan text fails closed as plan_artifact", async () => {
  const sim = createSimulator("wr023-block");
  const origInspect = sim.worker.inspect.bind(sim.worker);
  sim.worker.inspect = async (receipt) => {
    const result = await origInspect(receipt);
    if (result.summary?.startsWith("PLAN ")) {
      return {
        ...result,
        summary: `# BLOCKED\n\nNeed Jason before impl.\n\nclass: manual\n`,
      };
    }
    return result;
  };
  const controller = await seedWave(sim, "wave-block", ["FX-001"], {
    maxTokens: 80_000,
    maxLaunches: 4,
    maxRetriesPerStage: 0,
  });
  await controller.start("wave-block");
  await controller.runUntilIdle("wave-block");
  const t = controller.inspect("wave-block").tickets[0]!;
  assert.equal(t.status, "FAILED");
  assert.match(t.result ?? "", /plan_artifact/);
});

test("run-backlog-wave.sh does not invent Astra", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const script = readFileSync(join(root, "scripts/run-backlog-wave.sh"), "utf8");
  assert.doesNotMatch(script, /printf .*APPROVED by Astra/);
  assert.doesNotMatch(script, /auto plan-gate/);
});
