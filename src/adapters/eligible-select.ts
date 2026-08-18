import { parseFrontmatter, parseTicketFile, listMarkdownTickets } from "./markdown-tracker.js";

const TERMINAL = new Set(["done", "wontfix", "cancelled", "closed", "complete", "completed"]);

export type SelectSkip = { ticketId: string; reason: string };
export type EligibleSelectResult = {
  eligible: string[];
  skipped: SelectSkip[];
};

function agentEligible(data: Record<string, string | string[] | boolean>): boolean {
  const elig = String(data.eligibility ?? "").toLowerCase();
  if (elig === "agent_eligible") return true;
  const agent = data.agent_eligible;
  if (agent === true) return true;
  if (typeof agent === "string" && ["true", "yes", "1"].includes(agent.toLowerCase())) return true;
  return false;
}

export function selectEligibleTickets(repoRoot: string, issuesRoot?: string): EligibleSelectResult {
  const root = issuesRoot ?? `${repoRoot.replace(/\/$/, "")}/issues`;
  const files = listMarkdownTickets(root);
  const catalog = new Map<
    string,
    { status: string; eligible: boolean; deps: string[]; verify: boolean }
  >();
  for (const path of files) {
    const parsed = parseTicketFile(path, repoRoot);
    if (!parsed) continue;
    const { data } = parseFrontmatter(parsed.raw);
    catalog.set(parsed.ticketId, {
      status: (parsed.status || "open").toLowerCase(),
      eligible: agentEligible(data),
      deps: parsed.dependsOn,
      verify: Boolean(parsed.verifyCommand?.trim()),
    });
  }

  const depsOk = (tid: string): boolean => {
    for (const dep of catalog.get(tid)?.deps ?? []) {
      const d = catalog.get(dep);
      if (!d) return false;
      if (!TERMINAL.has(d.status)) return false;
    }
    return true;
  };

  const eligible: string[] = [];
  const skipped: SelectSkip[] = [];
  for (const tid of [...catalog.keys()].sort()) {
    const meta = catalog.get(tid)!;
    if (TERMINAL.has(meta.status)) continue;
    if (!["open", "in_progress", "todo", "ready", ""].includes(meta.status)) continue;
    if (!meta.eligible) continue;
    if (!depsOk(tid)) continue;
    if (!meta.verify) {
      skipped.push({ ticketId: tid, reason: `missing_verify ${tid}` });
      continue;
    }
    eligible.push(tid);
  }
  return { eligible, skipped };
}
