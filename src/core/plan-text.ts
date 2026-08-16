import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export function readActualPlanText(input: {
  ticketId: string;
  planClass?: string;
  summary?: string;
  outputRef?: string;
  outputDir?: string;
}): string {
  const candidates: string[] = [];
  if (input.outputDir) candidates.push(join(input.outputDir, "PLAN.md"));
  if (input.outputRef && existsSync(input.outputRef)) {
    try {
      const stat = statSync(input.outputRef);
      if (stat.isFile() && input.outputRef.endsWith("PLAN.md")) candidates.push(input.outputRef);
      else if (stat.isDirectory() && input.outputDir && input.outputRef === input.outputDir) {
        candidates.push(join(input.outputRef, "PLAN.md"));
      }
    } catch {
      // Never fall back to another stage's PLAN.md.
    }
  }
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, "utf8").trim();
      if (text) return text;
    } catch {
      // next candidate
    }
  }
  return `# PLAN ${input.ticketId}\n\n${input.summary ?? "deterministic plan"}\n\nclass: ${input.planClass ?? "manual"}\n`;
}
