import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const BODY_CAP = 8000;

export type VerifySnippet = {
  ok?: boolean;
  command?: string;
  classify?: string;
  stdout?: string;
  stderr?: string;
  output?: string;
  timedOut?: boolean;
};

export function clipVerifyBody(text: string, cap = BODY_CAP): string {
  const trimmed = text.replace(/\s+$/g, "");
  if (trimmed.length <= cap) return trimmed;
  return `${trimmed.slice(0, cap)}\n…(clipped)`;
}

export function readVerifyRecord(path: string | undefined): VerifySnippet | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as VerifySnippet;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function locateVerifyRecord(worktree?: string, verifyProof?: string): string | undefined {
  if (verifyProof && existsSync(verifyProof)) return verifyProof;
  if (!worktree) return undefined;
  const fallback = join(worktree, "WAVE_VERIFY.json");
  return existsSync(fallback) ? fallback : undefined;
}

export function inferVerifyClassify(record: VerifySnippet | undefined): string {
  if (record?.classify) return record.classify;
  if (record?.timedOut) return "runner_verify";
  return "product_verify";
}

export function copyVerifyIntoAttempt(worktree: string | undefined, outputDir: string, verifyProof?: string): void {
  const src = locateVerifyRecord(worktree, verifyProof);
  if (!src) return;
  mkdirSync(outputDir, { recursive: true });
  const dest = join(outputDir, "WAVE_VERIFY.json");
  if (src === dest) return;
  try {
    copyFileSync(src, dest);
  } catch {
    /* best-effort for the FIX retry dir */
  }
}

export function buildStagePrompt(input: {
  stage: "PLAN" | "IMPL" | "VERIFY";
  ticketId: string;
  title: string;
  attempt: number;
  worktree?: string;
  verifyProof?: string;
  verifyCommand?: string;
}): string {
  const short = `${input.stage} ${input.ticketId} ${input.title}`;
  if (input.stage !== "IMPL") return short;
  const path = locateVerifyRecord(input.worktree, input.verifyProof);
  const record = readVerifyRecord(path);
  if (input.attempt <= 1 && !record) return short;
  const classify = inferVerifyClassify(record);
  const command = record?.command?.trim() || input.verifyCommand?.trim() || "";
  const stdout = clipVerifyBody(record?.stdout ?? "");
  const stderr = clipVerifyBody(record?.stderr || record?.output || "");
  return `# FIX ${input.ticketId} IMPL retry

Previous verify failed (${classify}).
command: ${command}
classify: ${classify}

stdout:
${stdout}

stderr:
${stderr}

Fix the failing gates, then finish IMPL. ${short}
`;
}
