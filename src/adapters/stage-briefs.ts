import { join } from "node:path";

import type { LaunchIntent } from "./ports.js";

function terminalArtifact(stage: LaunchIntent["stage"]): string {
  if (stage === "PLAN") return "PLAN.md";
  if (stage === "IMPL") return "IMPL_DONE.json";
  if (stage === "REVIEW" || stage === "UX_REVIEW") return "terminal.json";
  return "VERIFY.json";
}

function terminalBlock(intent: LaunchIntent): string {
  const attempt = intent.attempt ?? 1;
  return JSON.stringify(
    {
      idempotencyKey: intent.idempotencyKey,
      waveId: intent.waveId,
      ticketId: intent.ticketId,
      stage: intent.stage,
      attempt,
      status: "succeeded",
      artifact: terminalArtifact(intent.stage),
    },
    null,
    2,
  );
}

export function stageBrief(intent: LaunchIntent, outputDir: string): string {
  const isolated = intent.worktree
    ? `Isolated worktree only: ${intent.worktree}. Do not touch any other checkout.`
    : "Do not touch any checkout.";
  const attempt = intent.attempt ?? 1;
  const terminal = terminalBlock(intent);
  const ticketBrief = intent.prompt.trim()
    ? `\nTicket/stage brief:\n\n${intent.prompt.trim()}\n`
    : "";
  if (intent.stage === "PLAN") {
    return `# ${intent.ticketId} PLAN ONLY

${isolated}

Fresh ACP session. PLAN ONLY. Do not implement product code.
Write the plan to ${join(outputDir, "PLAN.md")}.
Also write ${join(outputDir, "terminal.json")} with exactly these identity fields (optional hash is allowed):
${terminal}
${ticketBrief}
No deploy, push, merge, or Gateway changes. Then STOP.
`;
  }
  if (intent.stage === "REVIEW") {
    const forge = intent.worktree ?? "crawmak forge";
    return `# ${intent.ticketId} PLAN REVIEW

Forge cwd ${forge}. No product edits. No Astra/Jason stamp.
Read ${intent.approvedPlanPath ?? "the plan"}.
Write ${forge}/reviews/${intent.ticketId}.md (Verdict approve|approve-with-conditions|revise, ## Cheat-mode scan, ## Learn) and ${join(outputDir, "terminal.json")}:
${terminal}
${ticketBrief}
STOP.
`;
  }
  if (intent.stage === "UX_REVIEW") {
    const mona = intent.worktree ?? "mona workspace";
    const spec = intent.uxSpecPath ?? "the UX spec";
    return `# ${intent.ticketId} UX REVIEW

Mona cwd ${mona}. No product edits. No Astra/Jason stamp.
Read ${intent.approvedPlanPath ?? "the plan"} and UX spec ${spec}.
Write ${mona}/reviews/${intent.ticketId}-ux.md (Verdict approve|approve-with-conditions|revise) and ${join(outputDir, "terminal.json")}:
${terminal}
${ticketBrief}
STOP.
`;
  }
  if (intent.stage === "IMPL") {
    const plan = intent.approvedPlanPath ?? "the approved PLAN artifact";
    return `# ${intent.ticketId} IMPLEMENT

${isolated}

Fresh ACP session. Do not resume the PLAN conversation.
Execute the approved plan at ${plan}.
Write ${join(outputDir, "IMPL_DONE.json")} and ${join(outputDir, "terminal.json")} for IMPL attempt ${attempt}.
terminal.json must contain these identity fields (optional hash is allowed):
${terminal}
${ticketBrief}
PLAN.md is input only and never completes this stage.
No deploy, push, merge, or Gateway changes.
`;
  }
  return `# ${intent.ticketId} VERIFY

${isolated}

Fresh ACP session. Verify only. Write ${join(outputDir, "VERIFY.json")} and ${join(outputDir, "terminal.json")}.
terminal.json must contain these identity fields (optional hash is allowed):
${terminal}
${ticketBrief}
`;
}
