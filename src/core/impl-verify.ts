import type { TicketRun, WaveRecord } from "../domain/types.js";
import type { ControllerContext } from "./controller-context.js";

export async function runImplVerifyAndCommit(
  ctrl: ControllerContext,
  input: { waveId: string; ticket: TicketRun; wave: WaveRecord },
): Promise<{ proof?: string; fail?: string; implSha?: string }> {
  const worktree = input.ticket.implWorktree;
  const command = input.ticket.verifyCommand;
  if (!worktree || !command) return { fail: "missing_verify" };
  const verify = await ctrl.workspace.verify({ worktree, command });
  if (!verify.ok) {
    const classify = verify.classify ?? "product_verify";
    return { proof: verify.proof, fail: `${classify}: verify failed: ${command} (${verify.proof})` };
  }
  try {
    const committed = await ctrl.workspace.commitVerifiedWorktree({
      repoPath: input.wave.repoPath,
      worktree,
      ticketId: input.ticket.ticketId,
      waveId: input.waveId,
    });
    if (!committed.sha.trim()) {
      return { proof: verify.proof, fail: "commit-on-verify empty sha" };
    }
    return { proof: verify.proof, implSha: committed.sha };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { proof: verify.proof, fail: `commit-on-verify: ${detail}` };
  }
}
