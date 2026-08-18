const REASON_CAP = 500;

export type LandRecovery = {
  reason: "primary_dirty_overlap";
  overlap: string[];
  dirty: string[];
  incoming: string[];
  worktree: string;
  tip?: string;
  operator: string[];
};

export const LAND_RECOVERY_OPERATOR = [
  "commit or stash-unrelated dirt (never stash overlapping land paths)",
  "clean primary then rebase wave tip or run land-retry",
] as const;

export function clipReason(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= REASON_CAP ? t : `${t.slice(0, REASON_CAP - 1)}…`;
}

export function landRecoveryReceipt(input: {
  overlap: string[];
  dirty: string[];
  incoming: string[];
  worktree: string;
  tip?: string;
}): LandRecovery {
  return {
    reason: "primary_dirty_overlap",
    overlap: [...input.overlap],
    dirty: [...input.dirty],
    incoming: [...input.incoming],
    worktree: input.worktree,
    ...(input.tip ? { tip: input.tip } : {}),
    operator: [...LAND_RECOVERY_OPERATOR],
  };
}

export function closeoutDebtReason(error: string, proof?: string): string {
  const body = proof ? `land failed: ${error} (${proof})` : `land failed: ${error}`;
  return clipReason(`CLOSEOUT_DEBT: ${body}`);
}

export function primaryDirtyAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WAVE_PRIMARY_DIRTY === "allow";
}

export function isCloseoutDebt(result?: string): boolean {
  return Boolean(result?.includes("CLOSEOUT_DEBT:"));
}
