import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TURN_ERROR = /Unhandled error during turn:\s*(\{.*\})\s*Some\(/;
const GENERIC = /ACP_TURN_FAILED|Internal error/;

function defaultLogDir(): string {
  return join(homedir(), ".openclaw", "acpx");
}

function newestWrapperLogs(dir: string, limit = 8): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith("codex-acp-wrapper.stderr") && name.endsWith(".log"))
    .map((name) => join(dir, name))
    .sort((a, b) => {
      try {
        return statSync(b).mtimeMs - statSync(a).mtimeMs;
      } catch {
        return 0;
      }
    })
    .slice(0, limit);
}

function messageFromTurnJson(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as {
      error?: { message?: string };
      message?: string;
    };
    const msg = parsed.error?.message ?? parsed.message;
    return typeof msg === "string" && msg.trim() ? msg.trim() : undefined;
  } catch {
    return undefined;
  }
}

function lastTurnError(logPath: string): string | undefined {
  let text = "";
  try {
    text = readFileSync(logPath, "utf8");
  } catch {
    return undefined;
  }
  const matches = [...text.matchAll(new RegExp(TURN_ERROR, "g"))];
  const last = matches.at(-1)?.[1];
  return last ? messageFromTurnJson(last) : undefined;
}

/** ACP_TURN_FAILED Internal error hid the Sol/CLI 400. Pull the last wrapper turn error. */
export function enrichCodexTurnError(
  error: string | undefined,
  logDir = process.env.OPENCLAW_ACP_LOG_DIR ?? defaultLogDir(),
): string | undefined {
  const base = error?.trim() ?? "";
  if (!base || !GENERIC.test(base)) return error;
  for (const logPath of newestWrapperLogs(logDir)) {
    const msg = lastTurnError(logPath);
    if (msg) return `${base} (${msg})`;
  }
  return error;
}
