import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { GrokAcpWorker } from "../src/adapters/acp-worker.js";
import type { AcpSpawn, AcpSpawnResult, LaunchIntent } from "../src/adapters/ports.js";
import { stageAttemptDir, stageSessionKey } from "../src/adapters/stage-artifacts.js";
import { stageBrief } from "../src/adapters/stage-briefs.js";
import {
  IMPL_CONTRACT_CAP,
  IMPL_CONTRACT_FILE,
  extractImplContract,
  implContractRequired,
} from "../src/core/impl-contract.js";
import { createSimulator, seedWave } from "../src/sim/simulator.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES = join(ROOT, "test", "fixtures", "handoff");

function sha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeReview(
  forge: string,
  id: string,
  verdict: string,
  conditions?: string,
): void {
  mkdirSync(join(forge, "reviews"), { recursive: true });
  writeFileSync(join(forge, "AGENTS.md"), "# forge\n", "utf8");
  const cond =
    conditions === undefined
      ? ""
      : `\n## Conditions or revise\n${conditions}\n`;
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
${cond}
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

async function seedTicket(input: {
  label: string;
  ticketId: string;
  waveId: string;
  forge?: string;
  skip?: boolean;
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
    planReviewSkip: input.skip === true,
    body: input.ticketId,
  });
  const controller = await seedWave(sim, input.waveId, [input.ticketId], {
    maxTokens: 80_000,
    maxLaunches: 8,
  });
  if (input.forge) Object.assign(controller, { forgeRoot: input.forge });
  return { sim, controller };
}

test("extractImplContract table", () => {
  assert.equal(implContractRequired("approve-with-conditions"), true);
  assert.equal(implContractRequired("approve"), false);
  const awc = readFileSync(join(FIXTURES, "awc.md"), "utf8");
  const ok = extractImplContract(awc);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.match(ok.body, /state\.wait/);
    assert.doesNotMatch(ok.body, /Cheat-mode/);
  }
  const empty = extractImplContract(readFileSync(join(FIXTURES, "awc-empty.md"), "utf8"));
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.reason, "missing_impl_contract");
  assert.equal(extractImplContract(readFileSync(join(FIXTURES, "approve.md"), "utf8")).ok, false);
  const missingHeading = extractImplContract("# x\nVerdict: approve-with-conditions\n\n## Learn\n- bite: none\n");
  assert.equal(missingHeading.ok, false);
  const starred = extractImplContract("# r\n\n## **Conditions or revise**\n- keep density\n\n## Learn\n");
  assert.equal(starred.ok, true);
  if (starred.ok) assert.match(starred.body, /density/);
  const huge = extractImplContract(`# r\n\n## Conditions or revise\n${"x".repeat(IMPL_CONTRACT_CAP + 1)}\n`);
  assert.equal(huge.ok, false);
  if (!huge.ok) assert.equal(huge.reason, "impl_contract_too_large");
  assert.ok(huge.ok === false && huge.reason === "impl_contract_too_large");
});

test("AWC + conditions: admit IMPL, freeze contract, plan hash unchanged", async () => {
  const ticketId = "RV-047A";
  const waveId = "wave-047-awc";
  const forge = mkdtempSync(join(tmpdir(), "wr047-awc-"));
  writeReview(forge, ticketId, "approve-with-conditions", "- Dispatch wait to state.wait().\n");
  const { sim, controller } = await seedTicket({
    label: "wr047-awc",
    ticketId,
    waveId,
    forge,
  });
  await controller.start(waveId);
  await controller.runUntilIdle(waveId);
  const before = controller.inspect(waveId).tickets[0]?.planArtifact;
  assert.ok(before);
  const hash = sha(before);
  const view = controller.inspect(waveId);
  assert.equal(view.tickets[0]?.status, "DONE");
  assert.ok(sim.worker.intents.some((i) => i.stage === "IMPL"));
  const impl = sim.worker.intents.find((i) => i.stage === "IMPL");
  assert.ok(impl?.outputDir);
  const contract = join(impl.outputDir, IMPL_CONTRACT_FILE);
  assert.equal(existsSync(contract), true);
  assert.match(readFileSync(contract, "utf8"), /state\.wait/);
  assert.doesNotMatch(readFileSync(contract, "utf8"), /Cheat-mode scan/);
  assert.equal(sha(before), hash);
});

test("AWC empty / none / missing heading: PLAN_REVIEW, zero IMPL, no second REVIEW", async () => {
  for (const [label, conditions] of [
    ["missing", undefined],
    ["none", "none\n"],
    ["dash", "-\n"],
  ] as const) {
    const ticketId = `RV-047E-${label}`;
    const waveId = `wave-047-e-${label}`;
    const forge = mkdtempSync(join(tmpdir(), `wr047-e-${label}-`));
    writeReview(forge, ticketId, "approve-with-conditions", conditions);
    const { sim, controller } = await seedTicket({
      label: `wr047-e-${label}`,
      ticketId,
      waveId,
      forge,
    });
    await controller.start(waveId);
    await controller.runUntilIdle(waveId);
    const view = controller.inspect(waveId);
    assert.equal(view.tickets[0]?.status, "PLAN_REVIEW", label);
    assert.equal(view.tickets[0]?.result, "missing_impl_contract", label);
    assert.equal(
      sim.worker.intents.filter((i) => i.stage === "IMPL").length,
      0,
      label,
    );
    assert.equal(
      sim.worker.intents.filter((i) => i.stage === "REVIEW").length,
      1,
      label,
    );
  }
});

test("AWC over cap: impl_contract_too_large, no clip, no IMPL", async () => {
  const ticketId = "RV-047Z";
  const waveId = "wave-047-cap";
  const forge = mkdtempSync(join(tmpdir(), "wr047-cap-"));
  writeReview(forge, ticketId, "approve-with-conditions", `${"x".repeat(IMPL_CONTRACT_CAP + 1)}\n`);
  const { sim, controller } = await seedTicket({
    label: "wr047-cap",
    ticketId,
    waveId,
    forge,
  });
  await controller.start(waveId);
  await controller.runUntilIdle(waveId);
  const view = controller.inspect(waveId);
  assert.equal(view.tickets[0]?.status, "PLAN_REVIEW");
  assert.equal(view.tickets[0]?.result, "impl_contract_too_large");
  assert.ok(sim.worker.intents.every((i) => i.stage !== "IMPL"));
});

test("plain approve without conditions: IMPL, no contract file", async () => {
  const ticketId = "RV-047P";
  const waveId = "wave-047-approve";
  const forge = mkdtempSync(join(tmpdir(), "wr047-ok-"));
  writeReview(forge, ticketId, "approve");
  const { sim, controller } = await seedTicket({
    label: "wr047-ok",
    ticketId,
    waveId,
    forge,
  });
  await controller.start(waveId);
  await controller.runUntilIdle(waveId);
  assert.equal(controller.inspect(waveId).tickets[0]?.status, "DONE");
  const impl = sim.worker.intents.find((i) => i.stage === "IMPL");
  assert.ok(impl);
  assert.equal(existsSync(join(impl.outputDir ?? "", IMPL_CONTRACT_FILE)), false);
});

test("plan_review skip: IMPL without contract", async () => {
  const { sim, controller } = await seedTicket({
    label: "wr047-skip",
    ticketId: "RV-047S",
    waveId: "wave-047-skip",
    skip: true,
  });
  await controller.start("wave-047-skip");
  await controller.runUntilIdle("wave-047-skip");
  const view = controller.inspect("wave-047-skip");
  assert.equal(view.tickets[0]?.status, "DONE");
  assert.ok(view.events.some((e) => e.type === "plan_gate_auto"));
  const impl = sim.worker.intents.find((i) => i.stage === "IMPL");
  assert.ok(impl);
  assert.equal(existsSync(join(impl.outputDir ?? "", IMPL_CONTRACT_FILE)), false);
});

test("leftover stamp, no Crawmak launch: IMPL, no contract", async () => {
  const ticketId = "RV-047L";
  const waveId = "wave-047-left";
  const { sim, controller } = await seedTicket({
    label: "wr047-left",
    ticketId,
    waveId,
  });
  await controller.start(waveId);
  await controller.runUntilIdle(waveId);
  stampPlan(controller.inspect(waveId).tickets[0]?.planArtifact);
  await controller.runUntilIdle(waveId);
  const view = controller.inspect(waveId);
  assert.equal(view.tickets[0]?.status, "DONE");
  assert.ok(view.events.some((e) => e.type === "plan_review_admit"));
  const impl = sim.worker.intents.find((i) => i.stage === "IMPL");
  assert.ok(impl);
  assert.equal(existsSync(join(impl.outputDir ?? "", IMPL_CONTRACT_FILE)), false);
});

test("hop not ready: hung REVIEW does not admit AWC as contract", async () => {
  const ticketId = "RV-047H";
  const waveId = "wave-047-hop";
  const forge = mkdtempSync(join(tmpdir(), "wr047-hop-"));
  writeReview(forge, ticketId, "approve-with-conditions", "- keep density\n");
  const { sim, controller } = await seedTicket({
    label: "wr047-hop",
    ticketId,
    waveId,
    forge,
  });
  sim.worker.hangPrefix = ":REVIEW:";
  await controller.start(waveId);
  for (let i = 0; i < 8; i += 1) await controller.tick(waveId);
  const view = controller.inspect(waveId);
  assert.equal(view.tickets[0]?.status, "PLAN_REVIEW");
  assert.notEqual(view.tickets[0]?.result, "missing_impl_contract");
  assert.ok(sim.worker.intents.every((i) => i.stage !== "IMPL"));
});

test("stageBrief names IMPL_CONTRACT.md and not Cheat-mode scan", () => {
  const root = mkdtempSync(join(tmpdir(), "wr047-brief-"));
  const brief = stageBrief(
    {
      idempotencyKey: "w:T:IMPL:1",
      waveId: "w",
      ticketId: "T",
      stage: "IMPL",
      attempt: 1,
      prompt: "IMPL T",
      sessionKey: "s",
      outputDir: root,
      approvedPlanPath: join(FIXTURES, "plan.md"),
    },
    root,
  );
  assert.match(brief, /IMPL_CONTRACT\.md/);
  assert.doesNotMatch(brief, /Cheat-mode scan/);
});

class FakeAcp implements AcpSpawn {
  lastTask?: string;
  readonly bySource = new Map<string, AcpSpawnResult>();
  async spawn(request: Parameters<AcpSpawn["spawn"]>[0]) {
    this.lastTask = request.task;
    const result = { taskId: "t", runId: "r", sessionId: request.sessionKey };
    this.bySource.set(request.sourceId, result);
    return result;
  }
  async inspect() {
    return { status: "succeeded" as const };
  }
  async cancel() {
    return { cancelled: true };
  }
  async findBySourceId(sourceId: string) {
    return this.bySource.get(sourceId);
  }
}

test("ACP IMPL spawn task names IMPL_CONTRACT.md, not the review essay", async () => {
  const root = mkdtempSync(join(tmpdir(), "wr047-acp-"));
  writeFileSync(join(root, "approved-plan.md"), "# approved\n", "utf8");
  const acp = new FakeAcp();
  const worker = new GrokAcpWorker({ acp });
  const waveId = "wave-a";
  const ticketId = "MUD-047";
  const stage = "IMPL" as const;
  const attempt = 1;
  const intent: LaunchIntent = {
    idempotencyKey: `${waveId}:${ticketId}:${stage}:${attempt}`,
    waveId,
    ticketId,
    stage,
    attempt,
    prompt: `${stage} ${ticketId}`,
    sessionKey: stageSessionKey({ waveId, ticketId, stage, attempt }),
    worktree: root,
    outputDir: stageAttemptDir({ root, waveId, ticketId, stage, attempt }),
    approvedPlanPath: join(root, "approved-plan.md"),
  };
  await worker.launch(intent);
  assert.match(acp.lastTask ?? "", /IMPL_CONTRACT\.md/);
  assert.doesNotMatch(acp.lastTask ?? "", /Cheat-mode scan/);
  assert.doesNotMatch(acp.lastTask ?? "", /wait_yard rejects/);
});

test("probe:handoff exit 0 on AWC body, exit 1 on empty, no network", () => {
  const bin = join(ROOT, "dist", "scripts", "probe-impl-handoff.js");
  const ok = spawnSync(process.execPath, [bin, "--review", join(FIXTURES, "awc.md")], {
    encoding: "utf8",
    env: { ...process.env },
  });
  assert.equal(ok.status, 0, ok.stderr);
  const parsed = JSON.parse(ok.stdout) as { would_admit: boolean; chars: number };
  assert.equal(parsed.would_admit, true);
  assert.ok(parsed.chars > 0);
  const empty = spawnSync(process.execPath, [bin, "--review", join(FIXTURES, "awc-empty.md")], {
    encoding: "utf8",
  });
  assert.equal(empty.status, 1);
});
