import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const srcPath = join(process.cwd(), "scripts/codex-acp-compat.mjs");
const src = readFileSync(srcPath, "utf8");

type Compat = {
  splitModelThinking: (raw: string) => { model: string; thinking?: string };
  rewriteInbound: (message: unknown) => {
    message: Record<string, unknown>;
    followup?: { configId: string; value: string };
  };
  rewriteOutboundConfigOptions: (options: unknown) => unknown[];
};

async function loadCompat(): Promise<Compat> {
  return (await import(pathToFileURL(srcPath).href)) as Compat;
}

test("codex-acp-compat is Sol + thinking high, not gpt-5.5 / thinking off", () => {
  assert.match(src, /@agentclientprotocol\/codex-acp/);
  assert.match(src, /gpt-5\.6-sol\/high/);
  assert.match(src, /reasoning_effort/);
  assert.match(src, /Do not pin gpt-5\.5/);
  assert.match(src, /Do not pin thinking=off/);
  assert.doesNotMatch(src, /WAVE_CODEX_MODEL \?\? "gpt-5\.5"/);
});

test("splitModelThinking splits OpenClaw slash suffix and official brackets", async () => {
  const compat = await loadCompat();
  assert.deepEqual(compat.splitModelThinking("gpt-5.6-sol/high"), {
    model: "gpt-5.6-sol",
    thinking: "high",
  });
  assert.deepEqual(compat.splitModelThinking("openai/gpt-5.6-sol/high"), {
    model: "gpt-5.6-sol",
    thinking: "high",
  });
  assert.deepEqual(compat.splitModelThinking("gpt-5.6-sol[high]"), {
    model: "gpt-5.6-sol",
    thinking: "high",
  });
  assert.deepEqual(compat.splitModelThinking("gpt-5.6-sol"), {
    model: "gpt-5.6-sol",
    thinking: undefined,
  });
  assert.deepEqual(compat.splitModelThinking("openai/gpt-5.6-sol"), {
    model: "gpt-5.6-sol",
    thinking: undefined,
  });
});

test("advertised models include gpt-5.6-sol/high so OpenClaw spawn is accepted", async () => {
  const compat = await loadCompat();
  const options = compat.rewriteOutboundConfigOptions([
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "gpt-5.6-sol",
      options: [{ value: "gpt-5.6-sol", name: "gpt-5.6-sol" }],
    },
  ]);
  const model = options.find((option) => {
    const record = option as { id?: string };
    return record.id === "model";
  }) as { options?: Array<{ value: string }> };
  const values = new Set((model.options ?? []).map((option) => option.value));
  assert.equal(values.has("gpt-5.6-sol"), true);
  assert.equal(values.has("gpt-5.6-sol/high"), true);
  const thinking = options.find((option) => {
    const record = option as { id?: string };
    return record.id === "thinking";
  }) as { currentValue?: string };
  assert.equal(thinking?.currentValue, "high");
});

test("inbound model/high becomes bare model + reasoning_effort high", async () => {
  const compat = await loadCompat();
  const rewritten = compat.rewriteInbound({
    jsonrpc: "2.0",
    id: 1,
    method: "session/set_config_option",
    params: { sessionId: "s", configId: "model", value: "gpt-5.6-sol/high" },
  });
  const params = rewritten.message.params as { value?: string };
  assert.equal(params.value, "gpt-5.6-sol");
  assert.deepEqual(rewritten.followup, { configId: "reasoning_effort", value: "high" });
});

test("inbound thinking maps to reasoning_effort", async () => {
  const compat = await loadCompat();
  const rewritten = compat.rewriteInbound({
    jsonrpc: "2.0",
    id: 2,
    method: "session/set_config_option",
    params: { sessionId: "s", configId: "thinking", value: "high" },
  });
  const params = rewritten.message.params as { configId?: string; value?: string };
  assert.equal(params.configId, "reasoning_effort");
  assert.equal(params.value, "high");
});
