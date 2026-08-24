import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { LaunchReceipt } from "../domain/types.js";
import { readFileHungAt, type GrokSessionEvent } from "../core/stage-watchdog.js";

export function grokHomeDir(env: NodeJS.Dict<string> = process.env): string {
  const fromEnv = env.GROK_HOME?.trim();
  if (fromEnv) return fromEnv;
  return join(homedir(), ".grok");
}

export function worktreeFromOutputDir(outputDir: string | undefined): string | undefined {
  if (!outputDir) return undefined;
  const marker = "/tmp/wave-runs/";
  const at = outputDir.indexOf(marker);
  if (at <= 0) return undefined;
  return outputDir.slice(0, at);
}

export function sessionCwd(receipt: LaunchReceipt): string | undefined {
  const cwd = receipt.cwd?.trim();
  if (cwd) return cwd;
  return worktreeFromOutputDir(receipt.outputDir);
}

function parseEvents(path: string): GrokSessionEvent[] {
  const text = readFileSync(path, "utf8");
  const events: GrokSessionEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const rec = parsed as { ts?: unknown; type?: unknown; tool_name?: unknown };
      if (typeof rec.ts !== "string" || typeof rec.type !== "string") continue;
      events.push({
        ts: rec.ts,
        type: rec.type,
        ...(typeof rec.tool_name === "string" ? { tool_name: rec.tool_name } : {}),
      });
    } catch {
      // Skip malformed session lines.
    }
  }
  return events;
}

export function grokCwdHasHungReadFile(
  cwd: string,
  nowMs: number,
  hangMs: number,
  grokHome = grokHomeDir(),
): boolean {
  const root = join(grokHome, "sessions", encodeURIComponent(cwd));
  if (!existsSync(root)) return false;
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return false;
  }
  for (const name of names) {
    const eventsPath = join(root, name, "events.jsonl");
    try {
      if (!statSync(eventsPath).isFile()) continue;
    } catch {
      continue;
    }
    if (readFileHungAt(parseEvents(eventsPath), nowMs, hangMs)) return true;
  }
  return false;
}

export function receiptHasHungReadFile(
  receipt: LaunchReceipt,
  nowMs: number,
  hangMs: number,
  grokHome = grokHomeDir(),
): boolean {
  const cwd = sessionCwd(receipt);
  if (!cwd) return false;
  return grokCwdHasHungReadFile(cwd, nowMs, hangMs, grokHome);
}
