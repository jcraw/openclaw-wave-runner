/**
 * Minimal stub so `tsc` can typecheck without a full OpenClaw install.
 * At runtime the real `openclaw/plugin-sdk/plugin-entry` module is required.
 */
declare module "openclaw/plugin-sdk/plugin-entry" {
  export type OpenClawPluginApi = {
    config: unknown;
    runtime: {
      tasks: {
        managedFlows: {
          bindSession: (input: { sessionKey: string }) => unknown;
        };
        runs: {
          bindSession: (input: { sessionKey: string }) => {
            get: (taskId: string) =>
              | {
                  id: string;
                  status: string;
                  runId?: string;
                  childSessionKey?: string;
                  terminalSummary?: string;
                  error?: string;
                }
              | undefined;
          };
        };
      };
      subagent: unknown;
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
