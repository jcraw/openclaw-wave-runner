import type {
  BoundManagedFlows,
  FlowRecord,
  JsonValue,
  MutationResult,
  NativeSubagent,
  ReadOnlyTasks,
  TaskLinkResult,
  TaskRecord,
  WaveRunnerPorts,
} from "../src/contracts.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class FakeOpenClawRuntime {
  readonly flows = new Map<string, FlowRecord>();
  readonly tasks = new Map<string, TaskRecord>();
  readonly runs = new Map<string, { runId: string; sessionKey: string }>();
  launches = 0;
  private clock = 1_000;
  private nextFlow = 1;
  private nextTask = 1;
  private nextRun = 1;

  now = (): number => ++this.clock;

  private mutate(
    flowId: string,
    expectedRevision: number,
    patch: Partial<FlowRecord>,
  ): MutationResult {
    const current = this.flows.get(flowId);
    if (!current) {
      return { applied: false, code: "not_found" };
    }
    if (current.revision !== expectedRevision) {
      return { applied: false, code: "revision_conflict", current: clone(current) };
    }
    const next = { ...current, ...clone(patch), revision: current.revision + 1 };
    this.flows.set(flowId, next);
    return { applied: true, flow: clone(next) };
  }

  readonly managedFlows: BoundManagedFlows = {
    createManaged: (input) => {
      const flow: FlowRecord = {
        flowId: `flow-${this.nextFlow++}`,
        revision: 0,
        status: input.status ?? "queued",
        goal: input.goal,
        ...(input.currentStep ? { currentStep: input.currentStep } : {}),
        ...(input.stateJson !== undefined && input.stateJson !== null
          ? { stateJson: clone(input.stateJson) }
          : {}),
        ...(input.waitJson !== undefined && input.waitJson !== null
          ? { waitJson: clone(input.waitJson) }
          : {}),
      };
      this.flows.set(flow.flowId, flow);
      return clone(flow);
    },
    get: (flowId) => {
      const flow = this.flows.get(flowId);
      return flow ? clone(flow) : undefined;
    },
    list: () => [...this.flows.values()].map(clone),
    setWaiting: (input) =>
      this.mutate(input.flowId, input.expectedRevision, {
        status: "waiting",
        ...(input.currentStep === undefined
          ? {}
          : input.currentStep === null
            ? { currentStep: undefined }
            : { currentStep: input.currentStep }),
        ...(input.stateJson === undefined
          ? {}
          : input.stateJson === null
            ? { stateJson: undefined }
            : { stateJson: clone(input.stateJson) }),
        ...(input.waitJson === undefined
          ? {}
          : input.waitJson === null
            ? { waitJson: undefined }
            : { waitJson: clone(input.waitJson) }),
      }),
    resume: (input) =>
      this.mutate(input.flowId, input.expectedRevision, {
        status: input.status ?? "running",
        ...(input.currentStep === undefined
          ? {}
          : input.currentStep === null
            ? { currentStep: undefined }
            : { currentStep: input.currentStep }),
        ...(input.stateJson === undefined
          ? {}
          : input.stateJson === null
            ? { stateJson: undefined }
            : { stateJson: clone(input.stateJson) }),
        waitJson: undefined,
      }),
    finish: (input) =>
      this.mutate(input.flowId, input.expectedRevision, {
        status: "succeeded",
        ...(input.stateJson === undefined
          ? {}
          : input.stateJson === null
            ? { stateJson: undefined }
            : { stateJson: clone(input.stateJson) }),
        waitJson: undefined,
      }),
    cancel: async ({ flowId }) => {
      const flow = this.flows.get(flowId);
      if (!flow) {
        return { found: false, cancelled: false, reason: "Flow not found." };
      }
      const next: FlowRecord = {
        ...flow,
        status: "cancelled",
        cancelRequestedAt: this.now(),
        revision: flow.revision + 1,
      };
      this.flows.set(flowId, next);
      const linked = [...this.tasks.values()].filter((task) => {
        const state = next.stateJson as Record<string, unknown> | undefined;
        const child = state?.child as Record<string, unknown> | undefined;
        return child?.taskId === task.taskId;
      });
      for (const task of linked) {
        if (task.status === "queued" || task.status === "running") {
          task.status = "cancelled";
        }
      }
      return {
        found: true,
        cancelled: true,
        flow: clone(next),
        tasks: linked.map(clone),
      };
    },
    runTask: (input): TaskLinkResult => {
      const flow = this.flows.get(input.flowId);
      if (!flow) {
        return { created: false, found: false, reason: "Flow not found." };
      }
      if (flow.status === "cancelled" || flow.cancelRequestedAt !== undefined) {
        return {
          created: false,
          found: true,
          reason: "Flow cancellation has already been requested.",
          flow: clone(flow),
        };
      }
      const task: TaskRecord = {
        taskId: `task-${this.nextTask++}`,
        runId: input.runId,
        childSessionKey: input.childSessionKey,
        sourceId: input.sourceId,
        runtime: input.runtime,
        status: input.status,
      };
      this.tasks.set(task.taskId, task);
      return { created: true, flow: clone(flow), task: clone(task) };
    },
  };

  readonly readOnlyTasks: ReadOnlyTasks = {
    get: (taskId) => {
      const task = this.tasks.get(taskId);
      return task ? clone(task) : undefined;
    },
    findBySourceId: (sourceId) => {
      const task = [...this.tasks.values()].find((item) => item.sourceId === sourceId);
      return task ? clone(task) : undefined;
    },
    findByRunId: (runId) => {
      const task = [...this.tasks.values()].find((item) => item.runId === runId);
      return task ? clone(task) : undefined;
    },
    findBySessionKey: (childSessionKey) => {
      const task = [...this.tasks.values()].find((item) => item.childSessionKey === childSessionKey);
      return task ? clone(task) : undefined;
    },
  };

  readonly subagent: NativeSubagent = {
    run: async (input) => {
      this.launches += 1;
      const runId = `run-${this.nextRun++}`;
      this.runs.set(runId, { runId, sessionKey: input.sessionKey });
      return { runId };
    },
    waitForRun: async ({ runId }) => {
      const task = [...this.tasks.values()].find((item) => item.runId === runId);
      if (!task) {
        return { status: "error", error: "missing task" };
      }
      if (task.status === "running" || task.status === "queued") {
        task.status = "succeeded";
        task.terminalSummary = "WAVE_RUNNER_M0_CHILD_OK";
      }
      return { status: task.status === "succeeded" ? "ok" : "error" };
    },
  };

  ports(): WaveRunnerPorts {
    return {
      config: {},
      now: this.now,
      flows: this.managedFlows,
      tasks: this.readOnlyTasks,
      subagent: this.subagent,
    };
  }

  snapshot(): JsonValue {
    return {
      clock: this.clock,
      launches: this.launches,
      flows: [...this.flows.entries()],
      tasks: [...this.tasks.entries()],
      runs: [...this.runs.entries()],
    } as unknown as JsonValue;
  }

  static restore(snapshot: JsonValue): FakeOpenClawRuntime {
    const data = snapshot as unknown as {
      clock: number;
      launches: number;
      flows: Array<[string, FlowRecord]>;
      tasks: Array<[string, TaskRecord]>;
      runs: Array<[string, { runId: string; sessionKey: string }]>;
    };
    const runtime = new FakeOpenClawRuntime();
    runtime.clock = data.clock;
    runtime.launches = data.launches;
    for (const [key, flow] of data.flows) runtime.flows.set(key, clone(flow));
    for (const [key, task] of data.tasks) runtime.tasks.set(key, clone(task));
    for (const [key, run] of data.runs) runtime.runs.set(key, clone(run));
    runtime.nextFlow = runtime.flows.size + 1;
    runtime.nextTask = runtime.tasks.size + 1;
    runtime.nextRun = runtime.runs.size + 1;
    return runtime;
  }
}
