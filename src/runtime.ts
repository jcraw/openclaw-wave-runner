import { join } from "node:path";

import { GrokAcpWorker, MissingAcpSpawnWorker } from "./adapters/acp-worker.js";
import {
  createOpenClawCliGatewayRequest,
  gatewayRpcConfigured,
  resolveGatewayRpcConfig,
  type GatewayRequest,
  type GatewayRpcConfig,
} from "./adapters/gateway-rpc.js";
import { GrokCliWorker } from "./adapters/grok-cli.js";
import { MarkdownTracker } from "./adapters/markdown-tracker.js";
import { MockUsage, MockWorker, MockWorkflow, SafePolicy } from "./adapters/mocks.js";
import { OpenClawGatewayAcpSpawn } from "./adapters/openclaw-acp.js";
import type { AcpSpawn, TrackerAdapter, WorkerAdapter } from "./adapters/ports.js";
import { ManagedTaskFlowBackend, NativeSubagentWorker } from "./adapters/taskflow.js";
import { FailClosedUsage } from "./adapters/usage.js";
import { GitRepoAuthority } from "./adapters/repo-authority.js";
import { GitWorkspace } from "./adapters/workspace.js";
import type { WaveRunnerPorts } from "./contracts.js";
import { OWNER_SESSION_KEY } from "./controller.js";
import { SystemClock } from "./domain/clock.js";
import { SAFETY } from "./domain/safety.js";
import type { LaunchMode } from "./domain/types.js";
import { WaveController } from "./core/controller.js";
import { resolveCliOperatorIdentity } from "./core/repo-identity.js";
import { WaveDatabase } from "./store/database.js";

export function resolvePluginStorePath(stateDir: string): string {
  return join(stateDir, "wave-runner", "wave.sqlite");
}

export type ProductWorkerInput = {
  acp?: AcpSpawn;
  ports?: WaveRunnerPorts;
  allowNativeProof?: boolean;
  launcherPath?: string;
  repoPath?: string;
  ticketSourcePath?: string;
};

export function resolveProductWorker(input: ProductWorkerInput): WorkerAdapter {
  if (input.acp) {
    return new GrokAcpWorker({
      acp: input.acp,
      tasks: input.ports?.tasks,
      model: "grok-4.6",
    });
  }
  if (input.allowNativeProof && input.ports) {
    return new NativeSubagentWorker(input.ports.subagent);
  }
  if (input.launcherPath && input.repoPath) {
    return new GrokCliWorker({
      repoPath: input.repoPath,
      launcherPath: input.launcherPath,
      ticketSourcePath: input.ticketSourcePath,
      model: "grok-4.6",
    });
  }
  return new MissingAcpSpawnWorker();
}

export type CliAcpOptions = {
  acp?: AcpSpawn;
  autoAcp?: boolean;
  gateway?: GatewayRpcConfig;
  gatewayRequest?: GatewayRequest;
  acpSessionKey?: string;
  acpAgentId?: string;
  env?: NodeJS.ProcessEnv;
};

function envFlagEnabled(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function envFlagDisabled(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off";
}

export type CliControllerAcpFields = Pick<
  CliAcpOptions,
  "autoAcp" | "gateway" | "acpSessionKey" | "acpAgentId" | "env"
>;

/**
 * Map operator CLI flags onto the existing supervised ACP options.
 * `--launcher` is not part of this helper: it stays an explicit fallback only.
 */
export function cliControllerAcpFields(input: {
  supervised: boolean;
  disableAcp?: boolean;
  gatewayUrl?: string;
  gatewayToken?: string;
  acpSessionKey?: string;
  acpAgentId?: string;
  env?: NodeJS.ProcessEnv;
}): CliControllerAcpFields {
  const env = input.disableAcp
    ? { ...(input.env ?? process.env), WAVE_RUNNER_ACP: "0" }
    : input.env;
  return {
    autoAcp: input.supervised === true && input.disableAcp !== true,
    gateway: {
      ...(input.gatewayUrl?.trim() ? { url: input.gatewayUrl.trim() } : {}),
      ...(input.gatewayToken?.trim() ? { token: input.gatewayToken.trim() } : {}),
    },
    ...(input.acpSessionKey?.trim() ? { acpSessionKey: input.acpSessionKey.trim() } : {}),
    ...(input.acpAgentId?.trim() ? { acpAgentId: input.acpAgentId.trim() } : {}),
    ...(env ? { env } : {}),
  };
}

/**
 * Construct a live public ACP spawn for the supervised CLI/operator path.
 *
 * Returns undefined when Gateway/ACP cannot be configured. Callers must then
 * fail closed with MissingAcpSpawnWorker unless the operator explicitly passed
 * `--launcher` (compatibility fallback only).
 */
export function resolveCliAcpSpawn(input: CliAcpOptions = {}): AcpSpawn | undefined {
  if (input.acp) return input.acp;
  const env = input.env ?? process.env;
  if (envFlagDisabled(env.WAVE_RUNNER_ACP)) return undefined;
  const config = resolveGatewayRpcConfig({ ...input.gateway, env });
  const enabled =
    input.autoAcp === true ||
    input.gatewayRequest !== undefined ||
    gatewayRpcConfigured(config) ||
    envFlagEnabled(env.WAVE_RUNNER_ACP);
  if (!enabled) return undefined;
  const request = input.gatewayRequest ?? createOpenClawCliGatewayRequest(config);
  return new OpenClawGatewayAcpSpawn(
    request,
    input.acpSessionKey?.trim() || env.WAVE_RUNNER_ACP_SESSION_KEY?.trim() || OWNER_SESSION_KEY,
    input.acpAgentId?.trim() || env.WAVE_RUNNER_ACP_AGENT_ID?.trim() || "main",
  );
}

export function openWaveController(input: {
  stateDir: string;
  ports: WaveRunnerPorts;
  repoPath?: string;
  worktreeRoot?: string;
  artifactRoot?: string;
  launchMode?: LaunchMode;
  acp?: AcpSpawn;
  allowNativeProof?: boolean;
}): WaveController {
  const repoPath = input.repoPath ?? process.cwd();
  const isolatedRoot = input.worktreeRoot ?? join(input.stateDir, "wave-runner", "worktrees");
  const artifactRoot = input.artifactRoot ?? join(input.stateDir, "wave-runner", "artifacts");
  return new WaveController({
    db: new WaveDatabase(resolvePluginStorePath(input.stateDir)),
    clock: new SystemClock(),
    tracker: new MarkdownTracker(repoPath),
    workflow: new ManagedTaskFlowBackend(input.ports.flows),
    worker: resolveProductWorker({
      acp: input.acp ?? input.ports.acp,
      ports: input.ports,
      allowNativeProof: input.allowNativeProof === true,
    }),
    usage: new FailClosedUsage(),
    workspace: new GitWorkspace(),
    policy: new SafePolicy(),
    process: {
      holder: "wave-runner",
      processIdentity: "wave-runner-operator",
      pid: process.pid,
    },
    authority: new GitRepoAuthority(),
    worktreeRoot: isolatedRoot,
    artifactRoot,
    launchMode: input.launchMode ?? "supervised-bounded",
    leaseTtlMs: SAFETY.supervisedLeaseTtlMs,
    disableSourceMirror: true,
  });
}

export function openCliController(input: {
  dbPath: string;
  repoPath: string;
  supervised: boolean;
  waveId?: string;
  worktreeRoot?: string;
  artifactRoot?: string;
  launcherPath?: string;
  ticketSourcePath?: string;
  tracker?: TrackerAdapter;
  acp?: AcpSpawn;
  autoAcp?: boolean;
  gateway?: GatewayRpcConfig;
  gatewayRequest?: GatewayRequest;
  acpSessionKey?: string;
  acpAgentId?: string;
  env?: NodeJS.ProcessEnv;
}): WaveController {
  const isolatedRoot =
    input.worktreeRoot ?? join(input.repoPath, "tmp", "wave-runner", "worktrees");
  const artifactRoot =
    input.artifactRoot ?? join(input.repoPath, "tmp", "wave-runner", "artifacts");
  const tracker = input.tracker ?? new MarkdownTracker(input.repoPath);
  if (!input.supervised) {
    return new WaveController({
      db: new WaveDatabase(input.dbPath),
      clock: new SystemClock(),
      tracker,
      workflow: new MockWorkflow(),
      worker: new MockWorker(),
      usage: new MockUsage(),
      workspace: new GitWorkspace(),
      policy: new SafePolicy(),
      process: {
        holder: "cli",
        processIdentity: "cli-operator",
        pid: process.pid,
      },
      authority: new GitRepoAuthority(),
      worktreeRoot: isolatedRoot,
      artifactRoot,
      launchMode: "mock",
      disableSourceMirror: true,
    });
  }
  const acp = resolveCliAcpSpawn(input);
  return new WaveController({
    db: new WaveDatabase(input.dbPath),
    clock: new SystemClock(),
    tracker,
    workflow: new MockWorkflow(),
    worker: resolveProductWorker({
      acp,
      launcherPath: input.launcherPath,
      repoPath: input.repoPath,
      ticketSourcePath: input.ticketSourcePath,
    }),
    usage: new FailClosedUsage(),
    workspace: new GitWorkspace(),
    policy: new SafePolicy(),
    process: {
      holder: "cli-supervised",
      processIdentity: resolveCliOperatorIdentity({
        supervised: true,
        waveId: input.waveId,
        env: input.env,
      }),
      pid: process.pid,
    },
    authority: new GitRepoAuthority(),
    worktreeRoot: isolatedRoot,
    artifactRoot,
    launchMode: "supervised-bounded",
    leaseTtlMs: SAFETY.supervisedLeaseTtlMs,
    disableSourceMirror: true,
  });
}
