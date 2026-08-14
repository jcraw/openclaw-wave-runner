/**
 * Minimal compile-time stub so `tsc` works without a full OpenClaw install.
 * Runtime still requires the real `openclaw/plugin-sdk/plugin-entry` module.
 *
 * Shapes mirror the Wave Runner ports in `src/contracts.ts` closely enough
 * for typechecking the plugin entry.
 */
declare module "openclaw/plugin-sdk/plugin-entry" {
  type JsonValue =
    | null
    | boolean
    | number
    | string
    | JsonValue[]
    | { [key: string]: JsonValue };

  type FlowStatus =
    | "queued"
    | "running"
    | "waiting"
    | "blocked"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "lost";

  type TaskStatus =
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "timed_out"
    | "cancelled"
    | "lost";

  type FlowRecord = {
    flowId: string;
    revision: number;
    status: FlowStatus;
    goal: string;
    currentStep?: string;
    stateJson?: JsonValue;
    waitJson?: JsonValue;
    cancelRequestedAt?: number;
  };

  type TaskRecord = {
    id: string;
    status: TaskStatus;
    runId?: string;
    childSessionKey?: string;
    terminalSummary?: string;
    error?: string;
  };

  type MutationResult =
    | { applied: true; flow: FlowRecord }
    | {
        applied: false;
        code: "not_found" | "not_managed" | "revision_conflict" | "persist_failed";
        current?: FlowRecord;
      };

  type TaskLinkResult =
    | { created: true; flow: FlowRecord; task: { taskId: string; status: TaskStatus } }
    | { created: false; found: boolean; reason: string; flow?: FlowRecord };

  type BoundManagedFlows = {
    createManaged(input: {
      controllerId: string;
      goal: string;
      status?: FlowStatus;
      notifyPolicy?: "done_only" | "state_changes" | "silent";
      currentStep?: string | null;
      stateJson?: JsonValue | null;
      waitJson?: JsonValue | null;
    }): FlowRecord;
    get(flowId: string): FlowRecord | undefined;
    list(): FlowRecord[];
    setWaiting(input: {
      flowId: string;
      expectedRevision: number;
      currentStep?: string | null;
      stateJson?: JsonValue | null;
      waitJson?: JsonValue | null;
    }): MutationResult;
    setRunning(input: {
      flowId: string;
      expectedRevision: number;
      currentStep?: string | null;
      stateJson?: JsonValue | null;
      waitJson?: JsonValue | null;
    }): MutationResult;
    setBlocked(input: {
      flowId: string;
      expectedRevision: number;
      currentStep?: string | null;
      stateJson?: JsonValue | null;
      waitJson?: JsonValue | null;
    }): MutationResult;
    complete(input: {
      flowId: string;
      expectedRevision: number;
      status: "succeeded" | "failed" | "cancelled" | "lost";
      currentStep?: string | null;
      stateJson?: JsonValue | null;
      waitJson?: JsonValue | null;
    }): MutationResult;
    requestCancel(input: {
      flowId: string;
      expectedRevision?: number;
      reason?: string;
    }): MutationResult;
    linkTask(input: {
      flowId: string;
      expectedRevision: number;
      taskId: string;
      role?: string;
    }): TaskLinkResult;
  };

  type BoundTaskRuns = {
    get(taskId: string): TaskRecord | undefined;
  };

  type GatewayRequest = (
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<unknown> | unknown;

  export type OpenClawPluginApi = {
    config: unknown;
    runtime: {
      tasks: {
        managedFlows: {
          bindSession: (input: { sessionKey: string }) => BoundManagedFlows;
        };
        runs: {
          bindSession: (input: { sessionKey: string }) => BoundTaskRuns;
        };
      };
      subagent: {
        run?: (input: unknown) => Promise<unknown> | unknown;
        waitForRun?: (input: unknown) => Promise<unknown> | unknown;
        getSessionMessages?: (input: unknown) => Promise<unknown> | unknown;
      };
      gateway: {
        request: GatewayRequest;
      };
    };
    registerGatewayMethod: (
      name: string,
      handler: (args: {
        params: Record<string, unknown>;
        respond: (
          ok: boolean,
          payload?: unknown,
          error?: { code: string; message: string },
        ) => void;
      }) => unknown | Promise<unknown>,
      opts?: { scope?: string },
    ) => void;
  };

  export function definePluginEntry(def: {
    id: string;
    name: string;
    description?: string;
    register: (api: OpenClawPluginApi) => void;
  }): unknown;
}
