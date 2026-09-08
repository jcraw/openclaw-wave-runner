import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { OpenClawGatewayAcpSpawn } from "../src/adapters/openclaw-acp.js";
import { grokAcpAgentExists, RoutedProductWorker } from "../src/adapters/routed-worker.js";
import { GrokAcpWorker } from "../src/adapters/acp-worker.js";
import { GrokCliWorker } from "../src/adapters/grok-cli.js";
import type { AcpSpawn, LaunchIntent } from "../src/adapters/ports.js";
import { hasLiveOutbox, hasLiveWork, nextStuckCount, progressFingerprint } from "../src/core/operator-loop.js";
import { RUN_OPERATOR_ID, resolveCliOperatorIdentity } from "../src/core/repo-identity.js";
import { stageDeathNoRetry } from "../src/core/settlement.js";
import { WAVE_NEXT, WAVE_OWNERS } from "../src/core/state-machine.js";

import { resolveProductWorker } from "../src/runtime.js";
import { createSimulator, seedWave } from "../src/sim/simulator.js";
import { WaveDatabase } from "../src/store/database.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const supervisorSh = join(root, "scripts", "wave-supervisor.sh");
const operatorSh = join(root, "scripts", "wave-operator.sh");
const healthSh = join(root, "scripts", "supervisor-health.sh");
const cliJs = join(root, "dist", "scripts", "wave-cli.js");

function seedTicket(
  sim: ReturnType<typeof createSimulator>,
  ticket: {
    ticketId: string;
    title: string;
    planWorker?: string;
    planReviewSkip?: boolean;
    order?: number;
    dependsOn?: string[];
    sourcePath?: string;
  },
): void {
  sim.tracker.seed({
    ticketId: ticket.ticketId,
    title: ticket.title,
    contentHash: "",
    dependsOn: ticket.dependsOn ?? [],
    order: ticket.order ?? 1,
    sourcePath: ticket.sourcePath ?? `issues/${ticket.ticketId}.md`,
    verifyCommand: "true",
    planReviewSkip: ticket.planReviewSkip ?? true,
    planWorker: ticket.planWorker,
    body: ticket.ticketId,
  });
}

function markRunning(ctrl: { db: WaveDatabase }, waveId: string): void {
  const wave = ctrl.db.getWave(waveId);
  assert.ok(wave);
  wave.status = "RUNNING";
  wave.owner = WAVE_OWNERS.RUNNING;
  wave.nextAction = WAVE_NEXT.RUNNING;
  wave.revision += 1;
  ctrl.db.putWave(wave);
}

test("PENDING PLAN outbox is live work and resets stuck", () => {
  const view = {
    wave: { status: "RUNNING" as const },
    tickets: [{ ticketId: "RRT-136", status: "PLANNING", revision: 1, result: "" }],
    outbox: [{ outboxId: "obx-1", state: "PENDING" }],
    leases: [] as Array<{ resourceKey: string; holder: string; ticketId?: string }>,
  };
  assert.equal(hasLiveOutbox(view), true);
  assert.equal(hasLiveWork(view), true);
  const fp = progressFingerprint(view);
  assert.deepEqual(nextStuckCount(fp, fp, 20, 3, "RUNNING", hasLiveWork(view)), {
    count: 0,
    stuck: false,
  });
});

test("stageDeathNoRetry: unknown ACP grok + grok-cli Codex refuse", () => {
  assert.equal(
    stageDeathNoRetry({ reason: 'Unknown agent id "grok"', stage: "REVIEW", planWorker: "grok" }),
    true,
  );
  assert.equal(
    stageDeathNoRetry({
      reason: "grok CLI fallback refuses Codex PLAN",
      stage: "PLAN",
      planWorker: "codex",
    }),
    true,
  );
});

test("same-ledger Codex PLAN throw beside Grok PLAN success; tick-all does not throw", async () => {
  const sim = createSimulator("wr051-mixed");
  seedTicket(sim, { ticketId: "CX-001", title: "codex", planWorker: "codex", order: 1, dependsOn: [], sourcePath: "issues/CX-001.md" });
  seedTicket(sim, { ticketId: "GK-001", title: "grok", planWorker: "grok", order: 1, dependsOn: [], sourcePath: "issues/GK-001.md" });
  const ctrl = await seedWave(sim, "wave-codex", ["CX-001"]);
  await seedWave(sim, "wave-grok", ["GK-001"]);
  ctrl.freeze("wave-codex");
  ctrl.freeze("wave-grok");
  markRunning(ctrl, "wave-codex");
  markRunning(ctrl, "wave-grok");
  const orig = sim.worker.launch.bind(sim.worker);
  sim.worker.launch = async (intent: LaunchIntent) => {
    if (intent.agentId === "codex") {
      sim.worker.intents.push(intent);
      throw new Error("grok CLI fallback refuses Codex PLAN");
    }
    return orig(intent);
  };
  await ctrl.tickLive();
  const live = await ctrl.tickLive();
  const codex = ctrl.inspect("wave-codex");
  const grok = ctrl.inspect("wave-grok");
  assert.equal(live.waveIds.includes("wave-codex"), true);
  assert.equal(live.waveIds.includes("wave-grok"), true);
  assert.ok(
    codex.outbox.some((item) => item.state === "FAILED"),
    `codex outbox=${codex.outbox.map((item) => item.state).join(",")}`,
  );
  assert.equal(codex.tickets[0]?.status, "FAILED");
  assert.match(codex.tickets[0]?.result ?? "", /refuses Codex PLAN/);
  assert.equal(
    grok.outbox.filter((item) => item.stage === "PLAN" && item.state === "PENDING").length,
    0,
    `grok outbox=${grok.outbox.map((item) => `${item.stage}:${item.state}`).join(",")}`,
  );
  assert.ok(
    grok.outbox.some((item) => item.stage === "PLAN" && (item.state === "LAUNCHED" || item.state === "SETTLED")),
    `grok outbox=${grok.outbox.map((item) => `${item.stage}:${item.state}`).join(",")}`,
  );
  assert.notEqual(grok.tickets[0]?.status, "FAILED");
});

test("unknown ACP grok fail-closes REVIEW; sibling Grok PLAN still runs", async () => {
  const sim = createSimulator("wr051-review");
  seedTicket(sim, {
    ticketId: "RV-001",
    title: "review",
    planWorker: "grok",
    planReviewSkip: false,
    order: 1,
    dependsOn: [],
    sourcePath: "issues/RV-001.md",
  });
  seedTicket(sim, {
    ticketId: "PL-001",
    title: "plan",
    planWorker: "grok",
    planReviewSkip: true,
    order: 1,
    dependsOn: [],
    sourcePath: "issues/PL-001.md",
  });
  const ctrl = await seedWave(sim, "wave-review", ["RV-001"]);
  await seedWave(sim, "wave-plan", ["PL-001"]);
  ctrl.freeze("wave-review");
  ctrl.freeze("wave-plan");
  markRunning(ctrl, "wave-review");
  markRunning(ctrl, "wave-plan");
  const orig = sim.worker.launch.bind(sim.worker);
  sim.worker.launch = async (intent: LaunchIntent) => {
    if (intent.stage === "REVIEW") {
      sim.worker.intents.push(intent);
      throw new Error('Unknown agent id "grok"');
    }
    return orig(intent);
  };
  await ctrl.tickLive();
  await ctrl.tickLive();
  await ctrl.tickLive();
  const review = ctrl.inspect("wave-review");
  const plan = ctrl.inspect("wave-plan");
  const reviewOut = review.outbox.filter((item) => item.stage === "REVIEW");
  assert.ok(reviewOut.length === 0 || reviewOut.every((item) => item.state === "FAILED"));
  assert.equal(review.outbox.some((item) => item.state === "RECONCILING"), false);
  assert.ok(
    plan.outbox.some((item) => item.stage === "PLAN" && (item.state === "LAUNCHED" || item.state === "SETTLED")),
  );
  assert.equal(plan.outbox.filter((item) => item.stage === "PLAN" && item.state === "PENDING").length, 0);
});

test("receipt-less RECONCILING recover miss fail-closes", async () => {
  const sim = createSimulator("wr051-lost");
  const ctrl = await seedWave(sim, "wave-lost", ["FX-001"]);
  sim.worker.hangPrefix = ":PLAN:";
  sim.worker.completeOnInspect = false;
  await ctrl.start("wave-lost");
  const open = ctrl.db.listOutbox("wave-lost")[0];
  assert.ok(open, `outbox=${JSON.stringify(ctrl.db.listOutbox("wave-lost").map((item) => item.state))}`);
  ctrl.db.putOutbox({ ...open, state: "RECONCILING", receiptJson: undefined, updatedAt: ctrl.clock.now() });
  sim.worker.recover = async () => undefined;
  await ctrl.tick("wave-lost");
  const row = ctrl.db.getOutboxByIdempotency(open.idempotencyKey);
  assert.equal(row?.state, "FAILED");
  assert.match(row?.error ?? "", /lost_spawn|unknown_acp_agent/);
});

test("ACP spawn never sends agentId grok when probe misses; Codex still codex", async () => {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const request = async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
    calls.push({ method, params });
    if (method === "agents.list" || method === "agents_list") {
      return { agents: [{ id: "mona" }, { id: "robin" }, { id: "codex" }] } as T;
    }
    if (method === "tools.invoke") {
      return {
        ok: true,
        output: {
          content: [{ type: "text", text: JSON.stringify({ status: "accepted", runId: "run-c", childSessionKey: "sess-c" }) }],
        },
      } as T;
    }
    if (method === "tasks.list") {
      return { tasks: [{ taskId: "t-c", runtime: "acp", status: "running", title: "x", runId: "run-c", childSessionKey: "sess-c" }] } as T;
    }
    throw new Error(`unexpected ${method}`);
  };
  const acp = new OpenClawGatewayAcpSpawn(request, "agent:main:wave-runner-m0");
  await assert.rejects(
    () =>
      acp.spawn({
        agentId: "grok",
        mode: "run",
        sessionKey: "sk",
        task: "review",
        sourceId: "W:T:REVIEW:1",
      }),
    /Unknown agent id "grok"/,
  );
  assert.equal(
    calls.some((c) => c.method === "tools.invoke" && (c.params?.args as { agentId?: string } | undefined)?.agentId === "grok"),
    false,
  );
  await acp.spawn({
    agentId: "codex",
    mode: "run",
    sessionKey: "sk",
    task: "plan",
    sourceId: "W:T:PLAN:1",
  });
  const codexInvoke = calls.find((c) => c.method === "tools.invoke");
  assert.equal((codexInvoke?.params?.args as { agentId?: string }).agentId, "codex");
});

test("ACP+launcher routes Grok to grok-cli unless probe lists grok", () => {
  const fake: AcpSpawn = {
    async spawn() {
      return { runId: "r", sessionId: "s", taskId: "t" };
    },
    async inspect() {
      return { status: "running" };
    },
    async cancel() {
      return { cancelled: true };
    },
    async findBySourceId() {
      return undefined;
    },
  };
  const worker = resolveProductWorker({
    acp: fake,
    launcherPath: "/bin/true",
    repoPath: "/tmp/repo",
  });
  assert.ok(worker instanceof RoutedProductWorker);
  assert.equal(worker.kind, "routed-product");
});

test("empty supervised tick-all operator id defaults supervisor-wave-runner", () => {
  assert.equal(resolveCliOperatorIdentity({ supervised: true, env: {} }), RUN_OPERATOR_ID);
  assert.throws(
    () => resolveCliOperatorIdentity({ supervised: true, env: { WAVE_RUNNER_OPERATOR_ID: "/unsafe/path" } }),
    /unsafe/,
  );
  const dir = mkdtempSync(join(tmpdir(), "wr051-cli-"));
  const dbPath = join(dir, "wave.sqlite");
  new WaveDatabase(dbPath);
  const env = { ...process.env };
  delete env.WAVE_RUNNER_OPERATOR_ID;
  const ok = spawnSync("node", [cliJs, "tick-all", "--supervised", "--db", dbPath, "--repo", dir, "--no-acp"], {
    encoding: "utf8",
    env,
  });
  assert.equal(ok.status, 0, ok.stderr);
  const bad = spawnSync("node", [cliJs, "tick-all", "--supervised", "--db", dbPath, "--repo", dir, "--no-acp"], {
    encoding: "utf8",
    env: { ...process.env, WAVE_RUNNER_OPERATOR_ID: "/unsafe/path" },
  });
  assert.notEqual(bad.status, 0);
  assert.match(`${bad.stderr}${bad.stdout}`, /unsafe/);
});

test("wave-operator.sh forwards supervised ACP/launcher and keeps JOIN operator id", () => {
  const scratch = mkdtempSync(join(tmpdir(), "wr051-op-"));
  const argsLog = join(scratch, "args.log");
  const fake = join(scratch, "fake-cli.mjs");
  writeFileSync(
    fake,
    `import fs from "node:fs";
fs.appendFileSync(process.env.ARGS_LOG, JSON.stringify({argv:process.argv.slice(2),opId:process.env.WAVE_RUNNER_OPERATOR_ID})+"\\n");
process.stdout.write(JSON.stringify({waveIds:[],views:[]}));
`,
    "utf8",
  );
  chmodSync(fake, 0o755);
  const dbPath = join(scratch, "wave.sqlite");
  new WaveDatabase(dbPath);
  const r = spawnSync("bash", [operatorSh, "tick-all"], {
    encoding: "utf8",
    env: {
      ...process.env,
      WAVE_ID: "join-wave",
      REPO: root,
      OUT_DIR: scratch,
      WAVE_DB: dbPath,
      WAVE_RUNNER_OPERATOR_ID: RUN_OPERATOR_ID,
      WAVE_RUNNER_ACP: "0",
      WAVE_RUNNER_LAUNCHER: "/tmp/run_detached_builder.sh",
      PLUGIN_DIR: root,
      CLI_JS: fake,
      ARGS_LOG: argsLog,
    },
  });
  assert.equal(r.status, 0, r.stderr);
  const rec = JSON.parse(readFileSync(argsLog, "utf8").trim().split("\n")[0]!);
  assert.equal(rec.argv[0], "tick-all");
  assert.ok(rec.argv.includes("--supervised"));
  assert.ok(rec.argv.includes("--no-acp"));
  assert.ok(rec.argv.includes("--launcher"));
  assert.equal(rec.opId, RUN_OPERATOR_ID);
});

test("all-live supervisor keeps running when same-ledger tick-all returns 0 with a failed Codex lane", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "wr051-sup-"));
  mkdirSync(join(scratch, "ledgers"));
  writeFileSync(join(scratch, "ledgers", "shared.sqlite"), "");
  const fake = join(scratch, "fake-cli.mjs");
  writeFileSync(
    fake,
    `const op=process.argv[2];
if(op==="list-live"){process.stdout.write("/repo");process.exit(0)}
if(op==="tick-all"){
  process.stdout.write(JSON.stringify({
    waveIds:["wave-codex","wave-grok"],
    views:[
      {wave:{waveId:"wave-codex",status:"RUNNING"},tickets:[{ticketId:"CX-001",status:"FAILED",revision:2,result:"refuses Codex PLAN"}],outbox:[{outboxId:"a",state:"FAILED"}],leases:[]},
      {wave:{waveId:"wave-grok",status:"RUNNING"},tickets:[{ticketId:"GK-001",status:"PLANNING",revision:1,result:""}],outbox:[{outboxId:"b",state:"PENDING"}],leases:[]}
    ]
  }));
  process.exit(0);
}
process.exit(2);
`,
    "utf8",
  );
  chmodSync(fake, 0o755);
  const child = spawn("bash", [supervisorSh], {
    env: {
      ...process.env,
      WR: root,
      PLUGIN_DIR: root,
      WR_SCRATCH: scratch,
      CLI_JS: fake,
      WAVE_SKIP_SCRATCH_UUID: "1",
      WAVE_RUNNER_OPERATOR_ID: RUN_OPERATOR_ID,
      WAVE_SUPERVISOR_PIDFILE: join(scratch, "supervisor.pid"),
      TICK_SLEEP: "0",
      WAVE_IDLE_EXIT_S: "99999",
      STUCK_TICKS: "2",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(child.exitCode, null, "PENDING Grok lane must not OPERATOR_STOP stuck");
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("close", resolve));
});

test("wait_supervisor_alive fails without heartbeat and ensure path unlinks pidfile", () => {
  const scratch = mkdtempSync(join(tmpdir(), "wr051-wait-"));
  const pidfile = join(scratch, "supervisor.pid");
  writeFileSync(pidfile, `${process.pid}\n`);
  const r = spawnSync(
    "bash",
    [
      "-c",
      `source "${healthSh}"; WR_SCRATCH="${scratch}"; TICK_SLEEP=20; WAVE_SUPERVISOR_PIDFILE="${pidfile}";
       if wait_supervisor_alive 3; then echo alive; else rm -f "$WAVE_SUPERVISOR_PIDFILE"; echo unlinked; fi`,
    ],
    { encoding: "utf8", env: process.env },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /unlinked/);
  assert.equal(existsSync(pidfile), false);
});

test("grokAcpAgentExists is false without listAgentIds (route to CLI)", async () => {
  const fake: AcpSpawn = {
    async spawn() {
      return { runId: "r", sessionId: "s", taskId: "t" };
    },
    async inspect() {
      return { status: "running" };
    },
    async cancel() {
      return { cancelled: true };
    },
    async findBySourceId() {
      return undefined;
    },
  };
  assert.equal(await grokAcpAgentExists(fake)(), false);
  const acp = new GrokAcpWorker({ acp: fake });
  const cli = new GrokCliWorker({ repoPath: "/tmp/r", launcherPath: "/bin/true", exec: async () => ({ stdout: "builder_pid=1" }) });
  const routed = new RoutedProductWorker({ acp, cli, grokAcpOk: async () => false });
  assert.equal(routed.kind, "routed-product");
});
