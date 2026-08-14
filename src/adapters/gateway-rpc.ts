import { spawn } from "node:child_process";

/**
 * Public operator Gateway RPC used by CLI-supervised ACP spawn.
 *
 * This is the same method surface as in-process `api.runtime.gateway.request`
 * (`tools.invoke`, `tasks.list`, `tasks.get`, `tasks.cancel`). HTTP
 * `POST /tools/invoke` is not used: that endpoint denies `sessions_spawn`.
 */
export type GatewayRequest = <T = unknown>(
  method: string,
  params?: Record<string, unknown>,
  options?: { timeoutMs?: number },
) => Promise<T>;

export type GatewayRpcConfig = {
  url?: string;
  token?: string;
  password?: string;
  timeoutMs?: number;
  openclawBin?: string;
};

export type GatewayExecResult = {
  stdout: string;
  stderr: string;
  code: number;
};

export type GatewayExec = (
  argv: string[],
  opts?: { timeoutMs?: number },
) => Promise<GatewayExecResult>;

function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function toGatewayWsUrl(url: string): string {
  if (url.startsWith("http://")) return `ws://${url.slice("http://".length)}`;
  if (url.startsWith("https://")) return `wss://${url.slice("https://".length)}`;
  return url;
}

export function resolveGatewayRpcConfig(input?: {
  url?: string;
  token?: string;
  password?: string;
  timeoutMs?: number;
  openclawBin?: string;
  env?: NodeJS.ProcessEnv;
}): GatewayRpcConfig {
  const env = input?.env ?? process.env;
  return {
    ...(trimToUndefined(input?.url) ??
    trimToUndefined(env.OPENCLAW_GATEWAY_URL) ??
    trimToUndefined(env.WAVE_RUNNER_GATEWAY_URL)
      ? {
          url: toGatewayWsUrl(
            (trimToUndefined(input?.url) ??
              trimToUndefined(env.OPENCLAW_GATEWAY_URL) ??
              trimToUndefined(env.WAVE_RUNNER_GATEWAY_URL))!,
          ),
        }
      : {}),
    ...(trimToUndefined(input?.token) ??
    trimToUndefined(env.OPENCLAW_GATEWAY_TOKEN) ??
    trimToUndefined(env.WAVE_RUNNER_GATEWAY_TOKEN)
      ? {
          token:
            trimToUndefined(input?.token) ??
            trimToUndefined(env.OPENCLAW_GATEWAY_TOKEN) ??
            trimToUndefined(env.WAVE_RUNNER_GATEWAY_TOKEN),
        }
      : {}),
    ...(trimToUndefined(input?.password) ?? trimToUndefined(env.OPENCLAW_GATEWAY_PASSWORD)
      ? {
          password:
            trimToUndefined(input?.password) ?? trimToUndefined(env.OPENCLAW_GATEWAY_PASSWORD),
        }
      : {}),
    ...(typeof input?.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
      ? { timeoutMs: input.timeoutMs }
      : {}),
    ...(trimToUndefined(input?.openclawBin) ?? trimToUndefined(env.WAVE_RUNNER_OPENCLAW_BIN)
      ? {
          openclawBin:
            trimToUndefined(input?.openclawBin) ?? trimToUndefined(env.WAVE_RUNNER_OPENCLAW_BIN),
        }
      : {}),
  };
}

export function gatewayRpcConfigured(config: GatewayRpcConfig): boolean {
  return Boolean(config.url || config.token || config.password);
}

export function parseGatewayCallOutput(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) {
    throw new Error("openclaw gateway call returned empty output.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) {
      throw new Error("openclaw gateway call returned non-JSON output.");
    }
    parsed = JSON.parse(text.slice(start, end + 1));
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  const record = parsed as Record<string, unknown>;
  if (record.ok === false) {
    const error = record.error;
    const message =
      error && typeof error === "object" && !Array.isArray(error)
        ? String((error as { message?: unknown }).message ?? "Gateway RPC failed.")
        : "Gateway RPC failed.";
    throw new Error(message);
  }
  if ("payload" in record && record.payload !== undefined) return record.payload;
  if ("result" in record && record.result !== undefined) return record.result;
  return parsed;
}

export function buildGatewayCallArgv(
  method: string,
  params: Record<string, unknown> | undefined,
  config: GatewayRpcConfig,
  timeoutMs: number,
): string[] {
  const argv = [
    config.openclawBin ?? "openclaw",
    "gateway",
    "call",
    method,
    "--params",
    JSON.stringify(params ?? {}),
    "--json",
    "--timeout",
    String(timeoutMs),
  ];
  if (config.url) argv.push("--url", toGatewayWsUrl(config.url));
  if (config.token) argv.push("--token", config.token);
  if (config.password) argv.push("--password", config.password);
  return argv;
}

export function defaultGatewayExec(
  argv: string[],
  opts?: { timeoutMs?: number },
): Promise<GatewayExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer =
      typeof opts?.timeoutMs === "number"
        ? setTimeout(() => {
            child.kill("SIGTERM");
          }, opts.timeoutMs)
        : undefined;
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

export function createOpenClawCliGatewayRequest(
  config: GatewayRpcConfig = {},
  exec: GatewayExec = defaultGatewayExec,
): GatewayRequest {
  return async <T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<T> => {
    const timeoutMs = options?.timeoutMs ?? config.timeoutMs ?? 30_000;
    const argv = buildGatewayCallArgv(method, params, config, timeoutMs);
    let result: GatewayExecResult;
    try {
      result = await exec(argv, { timeoutMs: timeoutMs + 5_000 });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Gateway RPC ${method} unavailable (${detail}). Supervised product launch stays fail-closed.`,
      );
    }
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
      throw new Error(`Gateway RPC ${method} failed: ${detail}`);
    }
    return parseGatewayCallOutput(result.stdout) as T;
  };
}
