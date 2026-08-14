import { createHash } from "node:crypto";

import type {
  FlowRecord,
  JsonValue,
  MutationResult,
  TaskRecord,
  WaveRunnerPorts,
} from "./contracts.js";

export const CONTROLLER_ID = "wave-runner-m0/native-substrate-proof";
export const OWNER_SESSION_KEY = "agent:main:wave-runner-m0";
export const PROOF_MARKER = "WAVE_RUNNER_M0_CHILD_OK";

type FrozenState = {
  schema: 1;
  waveId: string;
  manifestHash: string;
  frozen: {
    selection: "m0-harmless-child-only";
    maxLaunches: 1;
    repoWrites: false;
    recurringScheduler: false;
  };
  stage:
    | "launching_child"
    | "child_running"
    | "waiting_approval"
    | "approved"
    | "finished";
  child?: {
    sessionKey: string;
    runId: string;
    taskId: string;
    terminalStatus?: string;
    terminalSummary?: string;
  };
  approvedAt?: number;
  finishedAt?: number;
};

const terminalTaskStatuses = new Set([
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "lost",
]);

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function manifestFor(waveId: string): FrozenState["frozen"] & { waveId: string } {
  return {
    waveId,
    selection: "m0-harmless-child-only",
    maxLaunches: 1,
    repoWrites: false,
    recurringScheduler: false,
  };
}

function makeInitialState(waveId: string): FrozenState {
  const frozen = manifestFor(waveId);
  return {
    schema: 1,
    waveId,
    manifestHash: createHash("sha256").update(stableStringify(frozen)).digest("hex"),
    frozen: {
      selection: frozen.selection,
      maxLaunches: frozen.maxLaunches,
      repoWrites: frozen.repoWrites,
      recurringScheduler: frozen.recurringScheduler,
    },
    stage: "launching_child",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readState(flow: FlowRecord): FrozenState {
  if (!isRecord(flow.stateJson) || flow.stateJson.schema !== 1) {
    throw new Error(`Flow ${flow.flowId} does not contain Wave Runner M0 state.`);
  }
  return flow.stateJson as unknown as FrozenState;
}

function requireApplied(result: MutationResult, action: string): FlowRecord {
  if (result.applied) {
    return result.flow;
  }
  throw new Error(
    `${action} rejected: ${result.code}` +
      (result.current ? ` (current revision ${result.current.revision})` : ""),
  );
}

function stateJson(state: FrozenState): JsonValue {
  return state as unknown as JsonValue;
}

export class WaveRunnerM0Controller {
  constructor(private readonly ports: WaveRunnerPorts) {}

  inspect(flowId: string): { flow: FlowRecord; state: FrozenState; task?: TaskRecord } {
    const flow = this.ports.flows.get(flowId);
    if (!flow) {
      throw new Error(`Flow not found: ${flowId}`);
    }
    const state = readState(flow);
    const task = state.child ? this.ports.tasks.get(state.child.taskId) : undefined;
    return { flow, state, ...(task ? { task } : {}) };
  }

  async start(waveId: string): Promise<{
    created: boolean;
    flow: FlowRecord;
    state: FrozenState;
  }> {
    const normalizedWaveId = waveId.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(normalizedWaveId)) {
      throw new Error("waveId must be 1-64 safe identifier characters.");
    }

    const existing = this.ports.flows.list().find((flow) => {
      try {
        return readState(flow).waveId === normalizedWaveId;
      } catch {
        return false;
      }
    });
    if (existing) {
      return { created: false, flow: existing, state: readState(existing) };
    }

    const initial = makeInitialState(normalizedWaveId);
    const created = this.ports.flows.createManaged({
      controllerId: CONTROLLER_ID,
      goal: `Wave Runner M0 native substrate proof: ${normalizedWaveId}`,
      status: "running",
      notifyPolicy: "silent",
      currentStep: "launch-harmless-child",
      stateJson: stateJson(initial),
    });

    const childSessionKey = `agent:main:subagent:wave-runner-m0-${normalizedWaveId}`;
    const taskText =
      `Harmless Wave Runner M0 substrate proof. Do not call tools, do not read or write files, ` +
      `and do not contact external services. Reply with exactly: ${PROOF_MARKER}`;
    const { runId } = await this.ports.subagent.run({
      sessionKey: childSessionKey,
      message: taskText,
      deliver: false,
      lightContext: true,
      idempotencyKey: `wave-runner-m0:${normalizedWaveId}:child:1`,
    });

    const linked = this.ports.flows.runTask({
      flowId: created.flowId,
      runtime: "subagent",
      sourceId: `wave-runner-m0:${normalizedWaveId}:child:1`,
      childSessionKey,
      runId,
      label: "m0-harmless-native-child",
      task: taskText,
      preferMetadata: true,
      notifyPolicy: "silent",
      status: "running",
      startedAt: this.ports.now(),
      progressSummary: "Native child launched and linked to managed flow.",
    });
    if (!linked.created) {
      throw new Error(`Child task linkage failed: ${linked.reason}`);
    }

    const runningState: FrozenState = {
      ...initial,
      stage: "child_running",
      child: {
        sessionKey: childSessionKey,
        runId,
        taskId: linked.task.taskId,
      },
    };
    const running = requireApplied(
      this.ports.flows.resume({
        flowId: created.flowId,
        expectedRevision: linked.flow.revision,
        status: "running",
        currentStep: "observe-child-terminal",
        stateJson: stateJson(runningState),
      }),
      "record child linkage",
    );
    return { created: true, flow: running, state: runningState };
  }

  async settleChild(flowId: string, timeoutMs = 30_000): Promise<{
    flow: FlowRecord;
    state: FrozenState;
    task: TaskRecord;
  }> {
    const snapshot = this.inspect(flowId);
    if (snapshot.flow.status === "waiting" && snapshot.state.stage === "waiting_approval") {
      if (!snapshot.task) {
        throw new Error("Waiting flow has no linked task record.");
      }
      return { flow: snapshot.flow, state: snapshot.state, task: snapshot.task };
    }
    if (snapshot.flow.status !== "running" || snapshot.state.stage !== "child_running") {
      throw new Error(`Flow is not awaiting child completion (status=${snapshot.flow.status}).`);
    }
    if (!snapshot.state.child) {
      throw new Error("Flow has no child receipt.");
    }

    const wait = await this.ports.subagent.waitForRun({
      runId: snapshot.state.child.runId,
      timeoutMs,
    });
    if (wait.status === "timeout") {
      throw new Error("Native child is still running; settle can be retried without relaunching.");
    }

    const current = this.inspect(flowId);
    const task = current.task;
    if (!task || !terminalTaskStatuses.has(task.status)) {
      throw new Error(
        "Native run ended but the linked task ledger record is not terminal yet; retry settle after the lifecycle event commits.",
      );
    }

    const waitingState: FrozenState = {
      ...current.state,
      stage: "waiting_approval",
      child: {
        ...current.state.child!,
        terminalStatus: task.status,
        ...(task.terminalSummary ? { terminalSummary: task.terminalSummary } : {}),
      },
    };
    const waiting = requireApplied(
      this.ports.flows.setWaiting({
        flowId,
        expectedRevision: current.flow.revision,
        currentStep: "await-operator-approval",
        stateJson: stateJson(waitingState),
        waitJson: {
          kind: "operator-approval",
          decision: "approve-m0-proof",
          expectedRevision: current.flow.revision + 1,
        },
      }),
      "enter durable approval wait",
    );
    return { flow: waiting, state: waitingState, task };
  }

  approve(flowId: string, expectedRevision: number): {
    flow: FlowRecord;
    state: FrozenState;
  } {
    const snapshot = this.inspect(flowId);
    if (snapshot.flow.status !== "waiting" || snapshot.state.stage !== "waiting_approval") {
      throw new Error("Only a flow in the durable approval wait can be approved.");
    }
    if (snapshot.flow.revision !== expectedRevision) {
      throw new Error(
        `Stale approval revision ${expectedRevision}; current revision is ${snapshot.flow.revision}.`,
      );
    }

    const approvedState: FrozenState = {
      ...snapshot.state,
      stage: "approved",
      approvedAt: this.ports.now(),
    };
    const resumed = requireApplied(
      this.ports.flows.resume({
        flowId,
        expectedRevision,
        status: "running",
        currentStep: "finish-proof",
        stateJson: stateJson(approvedState),
      }),
      "resume approved flow",
    );

    const finishedState: FrozenState = {
      ...approvedState,
      stage: "finished",
      finishedAt: this.ports.now(),
    };
    const finished = requireApplied(
      this.ports.flows.finish({
        flowId,
        expectedRevision: resumed.revision,
        stateJson: stateJson(finishedState),
      }),
      "finish approved flow",
    );
    return { flow: finished, state: finishedState };
  }

  async cancel(flowId: string) {
    return this.ports.flows.cancel({ flowId, cfg: this.ports.config });
  }
}
