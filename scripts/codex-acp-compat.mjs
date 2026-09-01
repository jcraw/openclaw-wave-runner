#!/usr/bin/env node
/**
 * Codex ACP compat for OpenClaw sessions_spawn.
 *
 * Inner agent: @agentclientprotocol/codex-acp (Codex 0.152+, gpt-5.6-sol).
 * OpenClaw concatenates thinking onto --model as `gpt-5.6-sol/high`.
 * Official adapter advertises bare ids + `reasoning_effort`, not slash-suffix
 * models or a `thinking` option. This wrapper advertises both, then rewrites
 * inbound config to bare model + reasoning_effort.
 *
 * Do not pin gpt-5.5. Do not pin thinking=off.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

export const THINKING_VALUES = ["off", "minimal", "low", "medium", "high", "xhigh"];
const THINKING = new Set(THINKING_VALUES);

export function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function stripOpenAiPrefix(value) {
  return value.toLowerCase().startsWith("openai/") ? value.slice(7) : value;
}

/** Split OpenClaw `model/thinking` or official `model[thinking]` from a bare id. */
export function splitModelThinking(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return { model: "", thinking: undefined };
  const bracket = value.match(/^(.*)\[([^\]]+)\]$/);
  if (bracket) {
    const thinking = bracket[2].trim().toLowerCase();
    return {
      model: stripOpenAiPrefix(bracket[1].trim()),
      thinking: THINKING.has(thinking) ? thinking : undefined,
    };
  }
  const rest = stripOpenAiPrefix(value);
  const parts = rest.split("/");
  const last = (parts[parts.length - 1] ?? "").trim().toLowerCase();
  if (parts.length >= 2 && THINKING.has(last)) {
    return { model: parts.slice(0, -1).join("/").trim(), thinking: last };
  }
  return { model: rest.trim(), thinking: undefined };
}

export function modelVariants(value) {
  const { model } = splitModelThinking(value);
  if (!model) return [];
  const ids = [model];
  for (const level of THINKING_VALUES) ids.push(`${model}/${level}`);
  return ids;
}

export function expandModelOptions(options) {
  if (!Array.isArray(options)) return options;
  const expanded = [];
  const seen = new Set();
  for (const option of options) {
    const record = asRecord(option);
    if (!record) {
      expanded.push(option);
      continue;
    }
    if (typeof record.group === "string" && Array.isArray(record.options)) {
      expanded.push({ ...record, options: expandModelOptions(record.options) });
      continue;
    }
    if (typeof record.value !== "string") {
      expanded.push(option);
      continue;
    }
    for (const value of modelVariants(record.value)) {
      if (seen.has(value)) continue;
      seen.add(value);
      expanded.push({ ...record, value, name: record.name || value });
    }
  }
  return expanded;
}

export function ensureThinkingOption(options) {
  const list = Array.isArray(options) ? [...options] : [];
  const byId = new Map();
  for (const option of list) {
    const record = asRecord(option);
    if (record && typeof record.id === "string") byId.set(record.id, record);
  }
  if (!byId.has("thinking")) {
    const effort = byId.get("reasoning_effort");
    const current =
      typeof effort?.currentValue === "string" && THINKING.has(effort.currentValue)
        ? effort.currentValue
        : "high";
    list.push({
      id: "thinking",
      name: "Thinking",
      category: "thinking",
      type: "select",
      currentValue: current,
      options: THINKING_VALUES.map((value) => ({ value, name: value })),
    });
  }
  return list;
}

export function rewriteOutboundConfigOptions(options) {
  const list = Array.isArray(options)
    ? options.map((option) => {
        const record = asRecord(option);
        if (!record) return option;
        if (record.id === "model" || record.category === "model") {
          return {
            ...record,
            ...(Array.isArray(record.options) ? { options: expandModelOptions(record.options) } : {}),
          };
        }
        return option;
      })
    : [];
  return ensureThinkingOption(list);
}

export function rewriteOutboundTree(value) {
  if (Array.isArray(value)) return value.map((item) => rewriteOutboundTree(item));
  const record = asRecord(value);
  if (!record) return value;
  const next = { ...record };
  if (Array.isArray(next.configOptions)) {
    next.configOptions = rewriteOutboundConfigOptions(next.configOptions);
  }
  if (next.update) next.update = rewriteOutboundTree(next.update);
  if (next.result) next.result = rewriteOutboundTree(next.result);
  if (next.params) next.params = rewriteOutboundTree(next.params);
  return next;
}

function configOptionId(message) {
  const params = asRecord(message?.params);
  if (!params) return undefined;
  if (typeof params.configId === "string") return params.configId;
  if (typeof params.category === "string") return params.category;
  return undefined;
}

export function rewriteInbound(message) {
  const record = asRecord(message);
  if (!record) return { message };
  const params = asRecord(record.params) ?? {};

  if (record.method === "session/set_config_option") {
    const id = configOptionId(record);
    const value = typeof params.value === "string" ? params.value : undefined;
    if (id === "model" && value) {
      const split = splitModelThinking(value);
      const followup =
        split.thinking && split.thinking !== "off"
          ? { configId: "reasoning_effort", value: split.thinking }
          : undefined;
      return {
        message: { ...record, params: { ...params, value: split.model || value } },
        followup,
      };
    }
    if ((id === "thinking" || id === "thought_level") && value) {
      return {
        message: {
          ...record,
          params: { ...params, configId: "reasoning_effort", category: "thought_level", value },
        },
      };
    }
  }

  if (record.method === "session/set_model") {
    const modelId = typeof params.modelId === "string" ? params.modelId : undefined;
    if (modelId) {
      const split = splitModelThinking(modelId);
      const rewritten =
        split.thinking && split.thinking !== "off" ? `${split.model}[${split.thinking}]` : split.model || modelId;
      return { message: { ...record, params: { ...params, modelId: rewritten } } };
    }
  }

  return { message: record };
}

function resolveOfficialAgent() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fromEnv = process.env.CODEX_ACP_AGENT?.trim();
  if (fromEnv) return fromEnv;
  const sibling = path.join(here, "official/node_modules/@agentclientprotocol/codex-acp/dist/index.js");
  if (existsSync(sibling)) return sibling;
  const home = path.join(
    homedir(),
    ".openclaw/acpx/official/node_modules/@agentclientprotocol/codex-acp/dist/index.js",
  );
  return home;
}

function resolveCodexHome() {
  const fromEnv = process.env.CODEX_HOME?.trim();
  if (fromEnv) return fromEnv;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sibling = path.join(here, "codex-home");
  if (existsSync(sibling)) return sibling;
  const home = path.join(homedir(), ".openclaw/acpx/codex-home");
  return existsSync(home) ? home : undefined;
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
}

function runBridge() {
  const agent = resolveOfficialAgent();
  if (!existsSync(agent)) {
    process.stderr.write(`codex-acp-compat: missing official adapter: ${agent}\n`);
    process.exit(1);
  }
  const nodeBin = "/home/j/.nvm/versions/node/v24.18.1/bin";
  const env = {
    ...process.env,
    PATH: `${nodeBin}:${process.env.PATH || ""}`,
  };
  const codexHome = resolveCodexHome();
  if (codexHome) env.CODEX_HOME = codexHome;

  const child = spawn(process.execPath, [agent, ...process.argv.slice(2)], {
    env,
    stdio: ["pipe", "pipe", "inherit"],
  });

  const syntheticIds = new Set();
  let syntheticSeq = 0;

  const clientLines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  clientLines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      child.stdin.write(`${line}\n`);
      return;
    }
    const rewritten = rewriteInbound(message);
    child.stdin.write(`${JSON.stringify(rewritten.message)}\n`);
    if (rewritten.followup && asRecord(message)?.params) {
      const parent = asRecord(message);
      const params = asRecord(parent?.params) ?? {};
      const followId = `codex-compat-${process.pid}-${++syntheticSeq}`;
      syntheticIds.add(followId);
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: followId,
          method: "session/set_config_option",
          params: {
            sessionId: params.sessionId,
            configId: rewritten.followup.configId,
            value: rewritten.followup.value,
          },
        })}\n`,
      );
    }
  });

  const agentLines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  agentLines.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      const id = asRecord(message)?.id;
      if (typeof id === "string" && syntheticIds.has(id)) {
        syntheticIds.delete(id);
        return;
      }
      process.stdout.write(`${JSON.stringify(rewriteOutboundTree(message))}\n`);
      return;
    } catch {
      // not JSON
    }
    process.stdout.write(`${line}\n`);
  });

  process.stdin.on("end", () => child.stdin.end());
  child.on("error", (error) => {
    process.stderr.write(`codex-acp-compat: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal));
  }
}

if (isDirectRun()) runBridge();
