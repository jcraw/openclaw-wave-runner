import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

import { OWNER_SESSION_KEY, WaveRunnerM0Controller } from "./controller.js";
import type { WaveRunnerPorts } from "./contracts.js";
import { DEFAULT_LIMITS, SUPERVISED_PILOT_LIMITS } from "./domain/types.js";
import { SAFETY } from "./domain/safety.js";
import { openWaveController } from "./runtime.js";
import { OpenClawGatewayAcpSpawn } from "./adapters/openclaw-acp.js";

function readString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} is required.`);
  }
  return value.trim();
}

function readInteger(params: Record<string, unknown>, key: string): number {
  const value = params[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${key} must be a non-negative integer.`);
  }
  return value;
}

function register(api: OpenClawPluginApi): void {
  const managed = api.runtime.tasks.managedFlows.bindSession({
    sessionKey: OWNER_SESSION_KEY,
  });
  const tasks = api.runtime.tasks.runs.bindSession({ sessionKey: OWNER_SESSION_KEY });
  const controller = new WaveRunnerM0Controller({
    config: api.config,
    now: Date.now,
    flows: managed,
    tasks: {
      get(taskId) {
        const task = tasks.get(taskId);
        if (!task) return undefined;
        return {
          taskId: task.id,
          status: task.status,
          ...(task.runId ? { runId: task.runId } : {}),
          ...(task.childSessionKey ? { childSessionKey: task.childSessionKey } : {}),
          ...(task.terminalSummary ? { terminalSummary: task.terminalSummary } : {}),
          ...(task.error ? { error: task.error } : {}),
        };
      },
    },
    subagent: api.runtime.subagent,
  } satisfies WaveRunnerPorts);

  const handler =
    (run: (params: Record<string, unknown>) => unknown | Promise<unknown>) =>
    async ({ params, respond }: { params: Record<string, unknown>; respond: (ok: boolean, payload?: unknown, error?: { code: string; message: string }) => void }) => {
      try {
        respond(true, await run(params));
      } catch (error) {
        respond(false, undefined, {
          code: "WAVE_RUNNER_M0_ERROR",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };

  api.registerGatewayMethod(
    "wave_runner_m0.start",
    handler((params) => controller.start(readString(params, "waveId"))),
    { scope: "operator.write" },
  );
  api.registerGatewayMethod(
    "wave_runner_m0.settle",
    handler((params) =>
      controller.settleChild(
        readString(params, "flowId"),
        params.timeoutMs === undefined ? 30_000 : readInteger(params, "timeoutMs"),
      ),
    ),
    { scope: "operator.write" },
  );
  api.registerGatewayMethod(
    "wave_runner_m0.approve",
    handler((params) =>
      controller.approve(
        readString(params, "flowId"),
        readInteger(params, "expectedRevision"),
      ),
    ),
    { scope: "operator.write" },
  );
  api.registerGatewayMethod(
    "wave_runner_m0.cancel",
    handler((params) => controller.cancel(readString(params, "flowId"))),
    { scope: "operator.write" },
  );
  api.registerGatewayMethod(
    "wave_runner_m0.inspect",
    handler((params) => controller.inspect(readString(params, "flowId"))),
    { scope: "operator.read" },
  );
  api.registerGatewayMethod(
    "wave_runner_m0.capabilities",
    handler(() => ({
      milestone: "M0",
      controllerId: "wave-runner-m0/native-substrate-proof",
      ownerSessionKey: OWNER_SESSION_KEY,
      backlogScan: false,
      repoWrites: false,
      recurringScheduler: false,
      workboardAuthority: false,
      usageMetadata: "not exposed by public Task Run DTO; reserve remains indeterminate",
    })),
    { scope: "operator.read" },
  );

  const ports: WaveRunnerPorts = {
    config: api.config,
    now: Date.now,
    flows: managed,
    tasks: {
      get(taskId) {
        const task = tasks.get(taskId);
        if (!task) return undefined;
        return {
          taskId: task.id,
          status: task.status,
          ...(task.runId ? { runId: task.runId } : {}),
          ...(task.childSessionKey ? { childSessionKey: task.childSessionKey } : {}),
          ...(task.terminalSummary ? { terminalSummary: task.terminalSummary } : {}),
          ...(task.error ? { error: task.error } : {}),
        };
      },
    },
    subagent: api.runtime.subagent,
    acp: new OpenClawGatewayAcpSpawn(
      api.runtime.gateway.request.bind(api.runtime.gateway),
      OWNER_SESSION_KEY,
    ),
  };
  const stateDir = process.env.OPENCLAW_STATE_DIR ?? "/tmp/wave-runner-fallback";

  const v0 =
    (run: (params: Record<string, unknown>) => unknown | Promise<unknown>) =>
    async ({
      params,
      respond,
    }: {
      params: Record<string, unknown>;
      respond: (ok: boolean, payload?: unknown, error?: { code: string; message: string }) => void;
    }) => {
      try {
        respond(true, await run(params));
      } catch (error) {
        respond(false, undefined, {
          code: "WAVE_RUNNER_ERROR",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };

  const wave = (params: Record<string, unknown>) =>
    openWaveController({
      stateDir,
      ports,
      repoPath: typeof params.repoPath === "string" ? params.repoPath : undefined,
      worktreeRoot: typeof params.worktreeRoot === "string" ? params.worktreeRoot : undefined,
      artifactRoot: typeof params.artifactRoot === "string" ? params.artifactRoot : undefined,
      launchMode: "supervised-bounded",
    });

  api.registerGatewayMethod(
    "wave_runner.capabilities",
    v0(() => ({
      milestone: "v0",
      productionDrainEnabled: false,
      overnightEnabled: false,
      productionWorkerLaunchEnabled: true,
      productWorkerRuntime: "openclaw-acp",
      supervisedOneTicketLaunchAllowed: true,
      supervisedBoundedLaunchAllowed: true,
      supervisedMaxTickets: 3,
      safety: { ...SAFETY },
      usageMetadata: "public Task Run DTO has no tokens; INDETERMINATE fail-closed",
    })),
    { scope: "operator.read" },
  );
  api.registerGatewayMethod(
    "wave_runner.dry_run",
    v0((params) =>
      wave(params).dryRun({
        waveId: readString(params, "waveId"),
        repoPath: readString(params, "repoPath"),
        ticketIds: readStringArray(params, "ticketIds"),
        limits: params.supervised === true ? { ...SUPERVISED_PILOT_LIMITS } : DEFAULT_LIMITS,
        supervisedBoundedPilot: params.supervised === true,
      }),
    ),
    { scope: "operator.read" },
  );
  api.registerGatewayMethod(
    "wave_runner.create",
    v0((params) =>
      wave(params).create({
        waveId: readString(params, "waveId"),
        repoPath: readString(params, "repoPath"),
        ticketIds: readStringArray(params, "ticketIds"),
        limits: params.supervised === true ? { ...SUPERVISED_PILOT_LIMITS } : DEFAULT_LIMITS,
        supervisedBoundedPilot: params.supervised === true,
        isolatedWorktreeRoot: typeof params.worktreeRoot === "string" ? params.worktreeRoot : undefined,
        operatorAction: params.supervised === true,
      }),
    ),
    { scope: "operator.write" },
  );
  api.registerGatewayMethod(
    "wave_runner.inspect",
    v0((params) => wave(params).inspect(readString(params, "waveId"))),
    { scope: "operator.read" },
  );
  api.registerGatewayMethod(
    "wave_runner.freeze",
    v0((params) => wave(params).freeze(readString(params, "waveId"))),
    { scope: "operator.write" },
  );
  api.registerGatewayMethod(
    "wave_runner.start",
    v0((params) =>
      wave(params).start(readString(params, "waveId"), undefined, undefined, {
        supervisedBoundedPilot: params.supervised === true,
        operatorAction: params.supervised === true,
      }),
    ),
    { scope: "operator.write" },
  );
  api.registerGatewayMethod(
    "wave_runner.tick",
    v0((params) => wave(params).tick(readString(params, "waveId"), {
      supervisedBoundedPilot: params.supervised === true,
      operatorAction: params.supervised === true,
    })),
    { scope: "operator.write" },
  );
  api.registerGatewayMethod(
    "wave_runner.resume",
    v0((params) => wave(params).resume(readString(params, "waveId"))),
    { scope: "operator.write" },
  );
  api.registerGatewayMethod(
    "wave_runner.pause",
    v0((params) => wave(params).pause(readString(params, "waveId"))),
    { scope: "operator.write" },
  );
  api.registerGatewayMethod(
    "wave_runner.cancel",
    v0((params) => wave(params).cancel(readString(params, "waveId"))),
    { scope: "operator.write" },
  );
  api.registerGatewayMethod(
    "wave_runner.approve",
    v0((params) =>
      wave(params).approve(
        readString(params, "waveId"),
        readString(params, "ticketId"),
        readInteger(params, "expectedRevision"),
      ),
    ),
    { scope: "operator.write" },
  );
  api.registerGatewayMethod(
    "wave_runner.project",
    v0((params) => wave(params).project()),
    { scope: "operator.read" },
  );
  api.registerGatewayMethod(
    "wave_runner.emergency_stop",
    v0((params) => wave(params).emergencyStop(typeof params.reason === "string" ? params.reason : undefined)),
    { scope: "operator.write" },
  );
}

function readStringArray(params: Record<string, unknown>, key: string): string[] {
  const value = params[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${key} must be a string array.`);
  }
  return value.map((item) => String(item));
}

const plugin: ReturnType<typeof definePluginEntry> = definePluginEntry({
  id: "wave-runner-m0",
  name: "Wave Runner",
  description: "Bounded backlog wave runner. Unrestricted/production drain disabled by default.",
  register,
});

export default plugin;
