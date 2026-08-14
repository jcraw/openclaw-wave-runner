import { spawn } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { LaunchReceipt, StageName } from "../domain/types.js";
import type { LaunchIntent, WorkerAdapter } from "./ports.js";
import {
  ensureStageAttemptDir,
  inspectStageArtifacts,
  readJsonFile,
  stageAttemptDir,
  writeJsonAtomic,
} from "./stage-artifacts.js";

export type GrokCliExec = (input: {
  command: string;
  args: string[];
  cwd: string;
}) => Promise<{ stdout: string; pid?: string }>;

export type GrokCliWorkerOptions = {
  repoPath: string;
  launcherPath: string;
  ticketSourcePath?: string;
  grokBin?: string;
  model?: string;
  exec?: GrokCliExec;
};

function defaultExec(input: {
  command: string;
  args: string[];
  cwd: string;
}): Promise<{ stdout: string; pid?: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `launcher exited ${code}`));
        return;
      }
      resolve({ stdout, pid: parsePid(stdout) });
    });
  });
}

function parsePid(stdout: string): string | undefined {
  const match = stdout.match(/builder_pid=(\d+)/) ?? stdout.match(/supervisor_pid=(\d+)/);
  return match?.[1];
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function attemptOf(intent: LaunchIntent): number {
  return intent.attempt ?? 1;
}

export function expectedCliOutputDir(intent: LaunchIntent, repoPath: string): string {
  if (intent.outputDir) return intent.outputDir;
  return stageAttemptDir({
    root: intent.worktree ?? repoPath,
    waveId: intent.waveId,
    ticketId: intent.ticketId,
    stage: intent.stage,
    attempt: attemptOf(intent),
  });
}

function parseStageFromKey(key: string): { waveId: string; ticketId: string; stage: StageName; attempt: number } {
  const parts = key.split(":");
  const stage = parts[2] === "IMPL" || parts[2] === "VERIFY" ? parts[2] : "PLAN";
  const attempt = Number(parts[3] ?? "1");
  return {
    waveId: parts[0] ?? "",
    ticketId: parts[1] ?? key,
    stage,
    attempt: Number.isInteger(attempt) && attempt > 0 ? attempt : 1,
  };
}

export class GrokCliWorker implements WorkerAdapter {
  readonly kind = "grok-cli-fallback";
  private readonly exec: GrokCliExec;
  private readonly receipts = new Map<string, LaunchReceipt>();

  constructor(private readonly opts: GrokCliWorkerOptions) {
    this.exec = opts.exec ?? defaultExec;
  }

  async launch(intent: LaunchIntent): Promise<LaunchReceipt> {
    const recovered = await this.recover(intent);
    if (recovered) return recovered;
    const cwd = intent.worktree ?? this.opts.repoPath;
    const outDir = expectedCliOutputDir(intent, this.opts.repoPath);
    if (intent.outputDir && intent.outputDir !== outDir) {
      throw new Error(`grok CLI fallback rejected unexpected outputDir ${intent.outputDir}`);
    }
    ensureStageAttemptDir(outDir);
    const phase = intent.stage === "IMPL" || intent.stage === "VERIFY" ? "implementing" : "planning";
    const briefName = phase === "implementing" ? "IMPL_BRIEF.md" : "PLAN_BRIEF.md";
    const briefPath = join(outDir, briefName);
    if (!existsSync(briefPath)) {
      writeFileSync(briefPath, defaultBrief(intent, outDir, phase), "utf8");
    }
    const args = [
      "--repo",
      cwd,
      "--ticket",
      intent.ticketId,
      "--worker",
      "grok",
      "--phase",
      phase,
      "--prompt-file",
      briefPath,
      "--out-dir",
      outDir,
      "--launch-key",
      intent.idempotencyKey,
    ];
    let ticketMd = this.opts.ticketSourcePath;
    if (ticketMd && existsSync(ticketMd)) {
      const dest = join(outDir, "TICKET.md");
      if (!existsSync(dest)) copyFileSync(ticketMd, dest);
      ticketMd = dest;
      args.push("--ticket-md", ticketMd);
    } else if (intent.worktree) {
      const found = findTicketMarkdown(intent.worktree, intent.ticketId);
      if (found) {
        const dest = join(outDir, "TICKET.md");
        if (!existsSync(dest)) copyFileSync(found, dest);
        args.push("--ticket-md", dest);
      }
    }
    if (intent.approvedPlanPath && existsSync(intent.approvedPlanPath)) {
      const dest = join(outDir, "APPROVED_PLAN.md");
      if (!existsSync(dest)) copyFileSync(intent.approvedPlanPath, dest);
    }
    const result = await this.exec({
      command: this.opts.launcherPath,
      args,
      cwd,
    });
    const pid = result.pid ?? parsePid(result.stdout);
    const receipt: LaunchReceipt = {
      idempotencyKey: intent.idempotencyKey,
      runId: pid ?? intent.idempotencyKey,
      sessionId: intent.sessionKey,
      provider: "grok-cli",
      model: this.opts.model ?? "grok-4.6",
      outputDir: outDir,
    };
    this.receipts.set(intent.idempotencyKey, receipt);
    writeJsonAtomic(join(outDir, "wave-launch.json"), {
      idempotencyKey: intent.idempotencyKey,
      stage: intent.stage,
      attempt: attemptOf(intent),
      pid,
      stdout: result.stdout.trim(),
      model: receipt.model,
      outputDir: outDir,
    });
    writeJsonAtomic(join(outDir, "launch-receipt.json"), receipt);
    return receipt;
  }

  async recover(intent: LaunchIntent): Promise<LaunchReceipt | undefined> {
    const cached = this.receipts.get(intent.idempotencyKey);
    if (cached) return cached;
    const outDir = expectedCliOutputDir(intent, this.opts.repoPath);
    const disk = readJsonFile<LaunchReceipt>(join(outDir, "launch-receipt.json"));
    if (disk?.idempotencyKey === intent.idempotencyKey) {
      if (disk.outputDir && disk.outputDir !== outDir) return undefined;
      this.receipts.set(intent.idempotencyKey, { ...disk, outputDir: outDir });
      return { ...disk, outputDir: outDir };
    }
    return undefined;
  }

  async inspect(receipt: LaunchReceipt) {
    const parsed = parseStageFromKey(receipt.idempotencyKey);
    const outDir = receipt.outputDir;
    if (!outDir) {
      return { status: "unknown" as const, error: "grok CLI fallback receipt is missing outputDir" };
    }
    const expected = this.receipts.get(receipt.idempotencyKey)?.outputDir ?? outDir;
    if (expected !== outDir) {
      return { status: "unknown" as const, error: "grok CLI fallback rejected outputDir mismatch" };
    }
    const pid = Number(receipt.runId);
    const live = Number.isInteger(pid) && pid > 0 && processAlive(pid);
    return inspectStageArtifacts({
      stage: parsed.stage,
      outputDir: outDir,
      idempotencyKey: receipt.idempotencyKey,
      waveId: parsed.waveId,
      ticketId: parsed.ticketId,
      attempt: parsed.attempt,
      live,
    });
  }

  async cancel() {
    return { cancelled: false, reason: "grok cancel is supervisor-owned" };
  }
}

function findTicketMarkdown(root: string, ticketId: string): string | undefined {
  const issues = join(root, "issues");
  if (!existsSync(issues)) return undefined;
  const stack = [issues];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.startsWith(".") || name.startsWith("_")) continue;
      const path = join(dir, name);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (name !== "node_modules" && name !== "tmp") stack.push(path);
      } else if (name.startsWith(`${ticketId}-`) && name.endsWith(".md")) {
        return path;
      } else if (name === `${ticketId}.md`) {
        return path;
      }
    }
  }
  return undefined;
}

function defaultBrief(
  intent: LaunchIntent,
  outDir: string,
  phase: "planning" | "implementing",
): string {
  const isolated = `Isolated worktree only. Do not touch any other checkout, especially a dirty primary. No deploy, push, merge, or Gateway changes.`;
  if (phase === "planning") {
    return `# ${intent.ticketId} PLAN ONLY

${isolated}

PLAN ONLY. Do not implement product code.
Write a dense plan to ${join(outDir, "PLAN.md")}.
Write ${join(outDir, "terminal.json")} for this PLAN attempt.
Then STOP.
`;
  }
  const plan = intent.approvedPlanPath ?? join(outDir, "APPROVED_PLAN.md");
  return `# ${intent.ticketId} IMPLEMENT

${isolated}

Fresh IMPL session. Execute the approved plan at ${plan}.
Write ${join(outDir, "IMPL_DONE.json")} and terminal.json.
PLAN.md never completes IMPL.
`;
}
