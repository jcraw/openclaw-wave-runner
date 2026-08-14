import type { LaunchReceipt, UsageResult } from "../domain/types.js";
import type { UsageAdapter } from "./ports.js";

/**
 * Public Task Run DTOs do not expose provider response IDs or token usage.
 * Fail closed: retain the full reservation as INDETERMINATE.
 */
export class FailClosedUsage implements UsageAdapter {
  async settle(receipt: LaunchReceipt): Promise<UsageResult> {
    return {
      kind: "indeterminate",
      reason: `no public usage fields on receipt ${receipt.idempotencyKey}`,
    };
  }
}

export class StaticUsage implements UsageAdapter {
  constructor(
    private readonly tokens: number,
    private readonly costMicros = 0,
  ) {}

  async settle(_receipt: LaunchReceipt): Promise<UsageResult> {
    return { kind: "actual", tokens: this.tokens, costMicros: this.costMicros };
  }
}
