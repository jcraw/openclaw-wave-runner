import type { LaunchReceipt } from "../domain/types.js";
import { GrokAcpWorker } from "./acp-worker.js";
import { grokAcpListed } from "./acp-grok-agent.js";
import { GrokCliWorker } from "./grok-cli.js";
import type { AcpSpawn, CancelResult, LaunchIntent, WorkerAdapter } from "./ports.js";
import type { WaveRunnerPorts } from "../contracts.js";

export type RoutedProductWorkerOptions = {
  acp: GrokAcpWorker;
  cli: GrokCliWorker;
  grokAcpOk: () => Promise<boolean>;
};

export type ProductWorkerInput = {
  acp?: AcpSpawn;
  ports?: WaveRunnerPorts;
  allowNativeProof?: boolean;
  launcherPath?: string;
  repoPath?: string;
  ticketSourcePath?: string;
};

export function buildProductWorker(input: ProductWorkerInput): WorkerAdapter | undefined {
  if (input.acp) {
    const acpWorker = new GrokAcpWorker({
      acp: input.acp,
      tasks: input.ports?.tasks,
      model: "grok-4.6",
    });
    if (input.launcherPath && input.repoPath) {
      return new RoutedProductWorker({
        acp: acpWorker,
        cli: new GrokCliWorker({
          repoPath: input.repoPath,
          launcherPath: input.launcherPath,
          ticketSourcePath: input.ticketSourcePath,
          model: "grok-4.6",
        }),
        grokAcpOk: grokAcpAgentExists(input.acp),
      });
    }
    return acpWorker;
  }
  if (input.launcherPath && input.repoPath) {
    return new GrokCliWorker({
      repoPath: input.repoPath,
      launcherPath: input.launcherPath,
      ticketSourcePath: input.ticketSourcePath,
      model: "grok-4.6",
    });
  }
  return undefined;
}

export function grokAcpAgentExists(acp: AcpSpawn, env: NodeJS.ProcessEnv = process.env): () => Promise<boolean> {
  return async () => {
    const list = (acp as { listAgentIds?: () => Promise<string[]> }).listAgentIds;
    if (!list) return false;
    return grokAcpListed(await list.call(acp), env);
  };
}

/**
 * ACP port + launcher: Codex/Mona stay on ACP; Grok uses grok-cli unless a probe
 * lists agent `grok` (or WAVE_GROK_ACP_AGENT_ID).
 */
export class RoutedProductWorker implements WorkerAdapter {
  readonly kind = "routed-product";

  constructor(private readonly opts: RoutedProductWorkerOptions) {}

  private async pick(intent: LaunchIntent): Promise<WorkerAdapter> {
    if (intent.agentId === "codex" || intent.agentId === "mona") return this.opts.acp;
    if (await this.opts.grokAcpOk()) return this.opts.acp;
    return this.opts.cli;
  }

  async launch(intent: LaunchIntent): Promise<LaunchReceipt> {
    return (await this.pick(intent)).launch(intent);
  }

  async recover(intent: LaunchIntent): Promise<LaunchReceipt | undefined> {
    const fromAcp = await this.opts.acp.recover(intent);
    if (fromAcp) return fromAcp;
    return this.opts.cli.recover(intent);
  }

  async inspect(receipt: LaunchReceipt) {
    if (receipt.provider === "grok-cli") return this.opts.cli.inspect(receipt);
    return this.opts.acp.inspect(receipt);
  }

  async cancel(receipt: LaunchReceipt): Promise<CancelResult> {
    if (receipt.provider === "grok-cli") return this.opts.cli.cancel();
    return this.opts.acp.cancel(receipt);
  }
}
