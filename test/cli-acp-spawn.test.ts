import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GrokAcpWorker, MissingAcpSpawnWorker } from "../src/adapters/acp-worker.js";
import { GrokCliWorker } from "../src/adapters/grok-cli.js";
import { OpenClawGatewayAcpSpawn } from "../src/adapters/openclaw-acp.js";
import type { AcpSpawn } from "../src/adapters/ports.js";
import { OWNER_SESSION_KEY } from "../src/controller.js";
import {
  cliControllerAcpFields,
  openCliController,
  resolveCliAcpSpawn,
  resolveProductWorker,
} from "../src/runtime.js";

const isolatedEnv: NodeJS.ProcessEnv = {};

function fakeAcp(): AcpSpawn {
  return {
    async spawn() {
      return { runId: "run", sessionId: "sess", taskId: "task" };
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
}

function supervisedController(
  input: Omit<Parameters<typeof openCliController>[0], "dbPath" | "supervised"> = {
    repoPath: "/tmp/repo",
  },
) {
  const root = mkdtempSync(join(tmpdir(), "wave-step1-cli-"));
  const { repoPath, env, worktreeRoot, artifactRoot, ...rest } = input;
  return openCliController({
    dbPath: join(root, "wave.sqlite"),
    repoPath: repoPath ?? root,
    worktreeRoot: worktreeRoot ?? join(root, "worktrees"),
    artifactRoot: artifactRoot ?? join(root, "artifacts"),
    env: env ?? isolatedEnv,
    waveId: "cli-acp",
    ...rest,
    supervised: true,
  });
}

test("Step 1: supervised CLI flags enable auto ACP and pass gateway/session overrides", () => {
  const fields = cliControllerAcpFields({
    supervised: true,
    gatewayUrl: "http://127.0.0.1:18789",
    gatewayToken: "tok",
    acpSessionKey: "agent:main:wave-runner-m0",
    acpAgentId: "main",
    env: isolatedEnv,
  });
  assert.equal(fields.autoAcp, true);
  assert.equal(fields.gateway?.url, "http://127.0.0.1:18789");
  assert.equal(fields.gateway?.token, "tok");
  assert.equal(fields.acpSessionKey, "agent:main:wave-runner-m0");
  assert.equal(fields.acpAgentId, "main");
});

test("Step 1: --no-acp / WAVE_RUNNER_ACP=0 wins over supervised autoAcp", () => {
  const fields = cliControllerAcpFields({
    supervised: true,
    disableAcp: true,
    env: { WAVE_RUNNER_ACP: "1" },
  });
  assert.equal(fields.autoAcp, false);
  assert.equal(fields.env?.WAVE_RUNNER_ACP, "0");
  assert.equal(
    resolveCliAcpSpawn({
      autoAcp: true,
      env: { WAVE_RUNNER_ACP: "0" },
    }),
    undefined,
  );
});

test("Step 1: ACP present resolves the product worker to GrokAcpWorker", () => {
  const spawn = resolveCliAcpSpawn({ autoAcp: true, env: isolatedEnv });
  assert.ok(spawn instanceof OpenClawGatewayAcpSpawn);
  const worker = resolveProductWorker({ acp: spawn, repoPath: "/tmp/repo" });
  assert.ok(worker instanceof GrokAcpWorker);
  assert.equal((worker as GrokAcpWorker).kind, "grok-acp");
  const controller = supervisedController({
    repoPath: "/tmp/repo",
    autoAcp: true,
    env: isolatedEnv,
  });
  assert.ok(controller.worker instanceof GrokAcpWorker);
  assert.equal(controller.launchMode, "supervised-bounded");
});

test("Step 1: injected gatewayRequest also constructs live public ACP spawn", () => {
  const spawn = resolveCliAcpSpawn({
    gatewayRequest: async () => {
      throw new Error("not called");
    },
    env: isolatedEnv,
    acpSessionKey: OWNER_SESSION_KEY,
    acpAgentId: "main",
  });
  assert.ok(spawn instanceof OpenClawGatewayAcpSpawn);
  const controller = supervisedController({
    repoPath: "/tmp/repo",
    gatewayRequest: async () => {
      throw new Error("not called");
    },
    env: isolatedEnv,
  });
  assert.ok(controller.worker instanceof GrokAcpWorker);
});

test("Step 1: ACP absent and no launcher fail closed on MissingAcpSpawnWorker", () => {
  assert.equal(resolveCliAcpSpawn({ env: isolatedEnv }), undefined);
  const worker = resolveProductWorker({ repoPath: "/tmp/repo" });
  assert.ok(worker instanceof MissingAcpSpawnWorker);
  assert.equal(worker.kind, "missing-acp");
  const controller = supervisedController({
    repoPath: "/tmp/repo",
    env: isolatedEnv,
  });
  assert.ok(controller.worker instanceof MissingAcpSpawnWorker);
});

test("Step 1: launcher is used only when explicitly provided and ACP is absent", () => {
  const fallback = resolveProductWorker({
    launcherPath: "/bin/true",
    repoPath: "/tmp/repo",
    ticketSourcePath: "/tmp/ticket.md",
  });
  assert.ok(fallback instanceof GrokCliWorker);
  assert.equal(fallback.kind, "grok-cli-fallback");

  const productWins = resolveProductWorker({
    acp: fakeAcp(),
    launcherPath: "/bin/true",
    repoPath: "/tmp/repo",
  });
  assert.ok(productWins instanceof GrokAcpWorker);

  const withLauncher = supervisedController({
    repoPath: "/tmp/repo",
    launcherPath: "/bin/true",
    env: isolatedEnv,
  });
  assert.ok(withLauncher.worker instanceof GrokCliWorker);

  const unsupervised = openCliController({
    dbPath: join(mkdtempSync(join(tmpdir(), "wave-step1-mock-")), "wave.sqlite"),
    repoPath: "/tmp/repo",
    supervised: false,
    launcherPath: "/bin/true",
    autoAcp: true,
    env: isolatedEnv,
  });
  assert.equal(unsupervised.launchMode, "mock");
  assert.equal(unsupervised.worker.constructor.name, "MockWorker");
});
