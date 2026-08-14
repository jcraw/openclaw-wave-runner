#!/usr/bin/env node

import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const PINNED_MODEL = process.env.GROK_MODEL?.trim() || "grok-4.6";
const PINNED_THINKING = process.env.GROK_THINKING?.trim() || "medium";
const GROK_COMMAND = process.env.GROK_COMMAND?.trim() || "grok";
const DEBUG_LOG = process.env.GROK_ACP_COMPAT_LOG?.trim();
const THINKING_VALUES = ["off", "minimal", "low", "medium", "high", "xhigh"];

const child = spawn(
  GROK_COMMAND,
  ["agent", "--model", PINNED_MODEL, "--always-approve", "stdio"],
  { stdio: ["pipe", "pipe", "inherit"] },
);

let latestConfigOptions = [];

function debug(direction, payload) {
  if (!DEBUG_LOG) return;
  try {
    appendFileSync(DEBUG_LOG, `${JSON.stringify({ ts: Date.now(), direction, payload })}\n`);
  } catch {
    // Debug logging must never break the ACP pipe.
  }
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function modelVariants(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return [];
  const bare = trimmed.includes("/") ? trimmed.slice(trimmed.indexOf("/") + 1) : trimmed;
  return [...new Set([trimmed, bare, `xai/${bare}`].filter(Boolean))];
}

function expandModelOptions(options) {
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

function ensureCompatConfigOptions(options) {
  const list = Array.isArray(options) ? [...options] : [];
  const byId = new Map();
  for (const option of list) {
    const record = asRecord(option);
    if (record && typeof record.id === "string") byId.set(record.id, record);
  }

  if (!byId.has("model")) {
    list.push({
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: PINNED_MODEL,
      options: expandModelOptions([
        { value: PINNED_MODEL, name: PINNED_MODEL },
        { value: "grok-4.5", name: "grok-4.5" },
      ]),
    });
  }

  if (!byId.has("thinking")) {
    list.push({
      id: "thinking",
      name: "Thinking",
      category: "thinking",
      type: "select",
      currentValue: PINNED_THINKING,
      options: THINKING_VALUES.map((value) => ({ value, name: value })),
    });
  }

  return list;
}

function withAdvertisedAliases(options) {
  const ensured = ensureCompatConfigOptions(options);
  return ensured.map((option) => {
    const record = asRecord(option);
    if (!record) return option;
    if (record.id === "model" || record.category === "model") {
      return {
        ...record,
        currentValue: PINNED_MODEL,
        ...(Array.isArray(record.options) ? { options: expandModelOptions(record.options) } : {}),
      };
    }
    if (record.id === "thinking" || record.category === "thinking") {
      return {
        ...record,
        currentValue:
          typeof record.currentValue === "string" && THINKING_VALUES.includes(record.currentValue)
            ? record.currentValue
            : PINNED_THINKING,
        options: THINKING_VALUES.map((value) => ({ value, name: value })),
      };
    }
    return option;
  });
}

function withLegacyModelAliases(models) {
  const record = asRecord(models);
  if (!record || !Array.isArray(record.availableModels)) return models;
  const seen = new Set();
  const availableModels = [];
  for (const entry of record.availableModels) {
    const model = asRecord(entry);
    if (!model || typeof model.modelId !== "string") {
      availableModels.push(entry);
      continue;
    }
    for (const modelId of modelVariants(model.modelId)) {
      if (seen.has(modelId)) continue;
      seen.add(modelId);
      availableModels.push({ ...model, modelId, name: model.name || modelId });
    }
  }
  return {
    ...record,
    currentModelId: typeof record.currentModelId === "string" ? PINNED_MODEL : record.currentModelId,
    availableModels,
  };
}

function rewriteTree(value, { forceConfigOptions = false } = {}) {
  if (Array.isArray(value)) return value.map((item) => rewriteTree(item));
  const record = asRecord(value);
  if (!record) return value;
  const next = { ...record };
  if (Array.isArray(next.configOptions) || forceConfigOptions) {
    next.configOptions = withAdvertisedAliases(next.configOptions);
    latestConfigOptions = next.configOptions;
  }
  if (next.models) next.models = withLegacyModelAliases(next.models);
  if (next.update) next.update = rewriteTree(next.update);
  if (next.result) next.result = rewriteTree(next.result, { forceConfigOptions });
  if (next.params) next.params = rewriteTree(next.params);
  return next;
}

function captureConfigOptions(message) {
  // session/new and session/load answers must advertise the OpenClaw-injected
  // options even when Grok itself returns none.
  const forceConfigOptions =
    message?.method === undefined &&
    (typeof message?.id === "string" || typeof message?.id === "number") &&
    asRecord(message?.result) !== undefined;
  const rewritten = rewriteTree(message, { forceConfigOptions });
  if (forceConfigOptions && asRecord(rewritten?.result)) {
    rewritten.result = {
      ...rewritten.result,
      configOptions: withAdvertisedAliases(rewritten.result.configOptions),
    };
    latestConfigOptions = rewritten.result.configOptions;
  }
  return rewritten;
}

function pinnedConfigOptions() {
  return withAdvertisedAliases(latestConfigOptions);
}

function configOptionId(message) {
  const params = asRecord(message?.params);
  if (!params) return undefined;
  if (typeof params.configId === "string") return params.configId;
  if (typeof params.category === "string") return params.category;
  return undefined;
}

function isLocallyHandledConfigRequest(message) {
  if (!(typeof message?.id === "string" || typeof message?.id === "number")) return false;
  if (message?.method === "session/set_model") return true;
  if (message?.method !== "session/set_config_option") return false;
  const id = configOptionId(message);
  // Grok agent argv pins model; thinking is OpenClaw session chrome only.
  return id === "model" || id === "thinking";
}

const clientLines = createInterface({ input: process.stdin, crlfDelay: Infinity });
clientLines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    debug("client-raw", line);
    child.stdin.write(`${line}\n`);
    return;
  }
  debug("client", message);

  // Host argv pins grok-4.6. OpenClaw still injects requester model/thinking.
  // Ack those locally so spawn is accepted without Grok advertising them.
  if (isLocallyHandledConfigRequest(message)) {
    const optionId = configOptionId(message);
    if (optionId === "thinking") {
      const value = asRecord(message.params)?.value;
      if (typeof value === "string" && THINKING_VALUES.includes(value)) {
        // Keep advertised currentValue honest for subsequent acks.
        latestConfigOptions = withAdvertisedAliases(latestConfigOptions).map((option) => {
          const record = asRecord(option);
          if (!record || record.id !== "thinking") return option;
          return { ...record, currentValue: value };
        });
      }
    }
    const result =
      message.method === "session/set_config_option"
        ? { configOptions: pinnedConfigOptions() }
        : {};
    debug("compat-ack", { id: message.id, method: message.method, optionId, result });
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
    return;
  }

  child.stdin.write(`${line}\n`);
});

const agentLines = createInterface({ input: child.stdout, crlfDelay: Infinity });
agentLines.on("line", (line) => {
  try {
    const message = JSON.parse(line);
    debug("agent", message);
    const rewritten = captureConfigOptions(message);
    debug("agent-rewritten", rewritten);
    process.stdout.write(`${JSON.stringify(rewritten)}\n`);
    return;
  } catch {
    debug("agent-raw", line);
  }
  process.stdout.write(`${line}\n`);
});

process.stdin.on("end", () => child.stdin.end());
child.on("error", (error) => {
  process.stderr.write(`grok-acp-compat: ${error.message}\n`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}
