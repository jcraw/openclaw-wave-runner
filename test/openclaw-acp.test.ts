import assert from "node:assert/strict";
import test from "node:test";

import { OpenClawGatewayAcpSpawn, __test } from "../src/adapters/openclaw-acp.js";

test("Gateway ACP adapter spawns through sessions_spawn and adopts the public task receipt", async () => {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const request = async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
    calls.push({ method, params });
    if (method === "tools.invoke") {
      return {
        ok: true,
        output: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "accepted",
                runId: "run-1",
                childSessionKey: "agent:main:acp:child-1",
              }),
            },
          ],
        },
      } as T;
    }
    if (method === "tasks.list") {
      return {
        tasks: [
          {
            taskId: "task-1",
            runtime: "acp",
            status: "running",
            title: __test.recoveryLabel("W:T:PLAN:1"),
            runId: "run-1",
            childSessionKey: "agent:main:acp:child-1",
          },
        ],
      } as T;
    }
    throw new Error(`unexpected ${method}`);
  };
  const acp = new OpenClawGatewayAcpSpawn(request, "agent:main:wave-runner-m0");
  const receipt = await acp.spawn({
    agentId: "grok",
    mode: "run",
    sessionKey: "ignored-by-openclaw",
    task: "Write PLAN.md",
    sourceId: "W:T:PLAN:1",
    cwd: "/tmp/worktree",
  });
  assert.deepEqual(receipt, {
    runId: "run-1",
    sessionId: "agent:main:acp:child-1",
    taskId: "task-1",
  });
  const invoke = calls[0];
  assert.equal(invoke.method, "tools.invoke");
  assert.equal(invoke.params?.name, "sessions_spawn");
  assert.deepEqual((invoke.params?.args as Record<string, unknown>).runtime, "acp");
  assert.deepEqual((invoke.params?.args as Record<string, unknown>).agentId, "grok");
  assert.deepEqual((invoke.params?.args as Record<string, unknown>).cwd, "/tmp/worktree");
  assert.equal((invoke.params?.args as Record<string, unknown>).timeoutSeconds, 90 * 60);
});

test("Gateway ACP adapter adopts the ACP row when a wrapper task shares the same runId", async () => {
  const request = async <T>(method: string): Promise<T> => {
    if (method === "tools.invoke") {
      return {
        ok: true,
        output: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "accepted",
                runId: "run-dual",
                childSessionKey: "agent:grok:acp:child-dual",
              }),
            },
          ],
        },
      } as T;
    }
    if (method === "tasks.list") {
      return {
        tasks: [
          {
            taskId: "wrapper-1",
            runtime: "subagent",
            status: "running",
            title: "wave-runner-step2",
            runId: "run-dual",
            childSessionKey: "agent:grok:acp:child-dual",
          },
          {
            taskId: "acp-1",
            runtime: "acp",
            status: "running",
            title: __test.recoveryLabel("W:T:PLAN:2"),
            runId: "run-dual",
            childSessionKey: "agent:grok:acp:child-dual",
          },
        ],
      } as T;
    }
    throw new Error(`unexpected ${method}`);
  };
  const acp = new OpenClawGatewayAcpSpawn(request, "agent:main:wave-runner-m0");
  const receipt = await acp.spawn({
    agentId: "grok",
    mode: "run",
    sessionKey: "ignored",
    task: "Write PLAN.md",
    sourceId: "W:T:PLAN:2",
    cwd: "/tmp/worktree",
  });
  assert.deepEqual(receipt, {
    runId: "run-dual",
    sessionId: "agent:grok:acp:child-dual",
    taskId: "acp-1",
  });
});

test("Gateway ACP adapter recovers, inspects, and cancels by deterministic task label", async () => {
  const label = __test.recoveryLabel("W:T:IMPL:1");
  const task = {
    taskId: "task-2",
    runtime: "acp",
    status: "completed",
    title: label,
    runId: "run-2",
    childSessionKey: "agent:main:acp:child-2",
    terminalSummary: "done",
  };
  const request = async <T>(method: string): Promise<T> => {
    if (method === "tasks.list") return { tasks: [task] } as T;
    if (method === "tasks.get") return { task } as T;
    if (method === "tasks.cancel") return { found: true, cancelled: true } as T;
    throw new Error(`unexpected ${method}`);
  };
  const acp = new OpenClawGatewayAcpSpawn(request, "agent:main:wave-runner-m0");
  assert.deepEqual(await acp.findBySourceId("W:T:IMPL:1"), {
    runId: "run-2",
    sessionId: "agent:main:acp:child-2",
    taskId: "task-2",
  });
  assert.deepEqual(
    await acp.inspect({ taskId: "task-2", sourceId: "W:T:IMPL:1" }),
    { status: "succeeded", summary: "done" },
  );
  assert.deepEqual(
    await acp.cancel({ taskId: "task-2", sourceId: "W:T:IMPL:1" }),
    { cancelled: true, reason: undefined },
  );
});

test("Gateway ACP adapter fails closed on an ambiguous recovery identity", async () => {
  const title = __test.recoveryLabel("W:T:VERIFY:1");
  const request = async <T>(): Promise<T> =>
    ({
      tasks: [
        { taskId: "one", runtime: "acp", status: "running", title, runId: "r1", childSessionKey: "s1" },
        { taskId: "two", runtime: "acp", status: "running", title, runId: "r2", childSessionKey: "s2" },
      ],
    }) as T;
  const acp = new OpenClawGatewayAcpSpawn(request, "agent:main:wave-runner-m0");
  await assert.rejects(() => acp.findBySourceId("W:T:VERIFY:1"), /ambiguous recovery/);
});
