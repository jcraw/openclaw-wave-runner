import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { GrokCliWorker } from "../src/adapters/grok-cli.js";
import { inspectReceiptArtifacts, inspectReviewHop } from "../src/adapters/stage-artifacts.js";
import type { LaunchIntent } from "../src/adapters/ports.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const healthSh = join(root, "scripts", "supervisor-health.sh");

function writeReview(forge: string, id: string, verdict: string, theater = false): void {
  mkdirSync(join(forge, "reviews"), { recursive: true });
  writeFileSync(join(forge, "AGENTS.md"), "# forge\n", "utf8");
  const body = theater
    ? `# REVIEW ${id}\n\nLooks fine.\n`
    : `# REVIEW ${id}

Verdict: ${verdict}

## Cheat-mode scan
- test-weaken: pass

## Learn
- bite: none
`;
  writeFileSync(join(forge, "reviews", `${id}.md`), body, "utf8");
}

function reviewIntent(forge: string, outDir: string): LaunchIntent {
  return {
    idempotencyKey: "w:T:REVIEW:1",
    waveId: "w",
    ticketId: "T",
    stage: "REVIEW",
    attempt: 1,
    prompt: "review",
    sessionKey: "s",
    worktree: forge,
    outputDir: outDir,
    agentId: "grok",
  };
}

test("Grok-cli REVIEW launches jam reviewing at forge cwd, not planning", async () => {
  const forge = mkdtempSync(join(tmpdir(), "wr052-forge-"));
  writeFileSync(join(forge, "AGENTS.md"), "# forge\n", "utf8");
  const outDir = join(forge, "review-out");
  mkdirSync(outDir, { recursive: true });
  let captured: { command: string; args: string[]; cwd: string } | undefined;
  const worker = new GrokCliWorker({
    repoPath: "/tmp/product",
    launcherPath: "/bin/true",
    exec: async (input) => {
      captured = input;
      return { stdout: "builder_pid=1" };
    },
  });
  const receipt = await worker.launch(reviewIntent(forge, outDir));
  assert.equal(receipt.provider, "grok-cli");
  assert.equal(receipt.cwd, forge);
  assert.ok(captured);
  assert.equal(captured.cwd, forge);
  assert.ok(captured.args.includes("reviewing"));
  assert.ok(!captured.args.includes("planning"));
  const repoIdx = captured.args.indexOf("--repo");
  assert.equal(captured.args[repoIdx + 1], forge);
  const phaseIdx = captured.args.indexOf("--phase");
  assert.equal(captured.args[phaseIdx + 1], "reviewing");
  const promptIdx = captured.args.indexOf("--prompt-file");
  assert.match(captured.args[promptIdx + 1] ?? "", /REVIEW_BRIEF\.md$/);
  assert.ok(captured.args.includes("grok-review"));
});

test("Grok-cli PLAN still uses planning", async () => {
  const repo = mkdtempSync(join(tmpdir(), "wr052-plan-"));
  const outDir = join(repo, "plan-out");
  mkdirSync(outDir, { recursive: true });
  let captured: { args: string[] } | undefined;
  const worker = new GrokCliWorker({
    repoPath: repo,
    launcherPath: "/bin/true",
    exec: async (input) => {
      captured = input;
      return { stdout: "builder_pid=2" };
    },
  });
  await worker.launch({
    idempotencyKey: "w:T:PLAN:1",
    waveId: "w",
    ticketId: "T",
    stage: "PLAN",
    attempt: 1,
    prompt: "plan",
    sessionKey: "s",
    worktree: repo,
    outputDir: outDir,
    agentId: "grok",
  });
  const phaseIdx = captured!.args.indexOf("--phase");
  assert.equal(captured!.args[phaseIdx + 1], "planning");
});

test("inspect REVIEW succeeds on crawmak reviews file without terminal.json", async () => {
  const forge = mkdtempSync(join(tmpdir(), "wr052-insp-"));
  const outDir = mkdtempSync(join(tmpdir(), "wr052-out-"));
  writeReview(forge, "T", "approve");
  const truth = inspectReceiptArtifacts({
    idempotencyKey: "w:T:REVIEW:1",
    outputDir: outDir,
    cwd: forge,
  });
  assert.equal(truth?.status, "succeeded");
  assert.match(truth?.outputRef ?? "", /reviews\/T\.md$/);
  assert.equal(truth?.summary, "approve");
});

test("inspect REVIEW theater fails closed", () => {
  const forge = mkdtempSync(join(tmpdir(), "wr052-th-"));
  const outDir = mkdtempSync(join(tmpdir(), "wr052-thout-"));
  writeReview(forge, "T", "approve", true);
  const truth = inspectReviewHop({
    stage: "REVIEW",
    outputDir: outDir,
    idempotencyKey: "w:T:REVIEW:1",
    waveId: "w",
    ticketId: "T",
    attempt: 1,
    forgeRoot: forge,
  });
  assert.equal(truth.status, "failed");
  assert.equal(truth.error, "review_theater");
});

test("inspect REVIEW missing file stays unknown (not cancelled)", () => {
  const forge = mkdtempSync(join(tmpdir(), "wr052-miss-"));
  writeFileSync(join(forge, "AGENTS.md"), "# forge\n", "utf8");
  mkdirSync(join(forge, "reviews"), { recursive: true });
  const outDir = mkdtempSync(join(tmpdir(), "wr052-missout-"));
  const truth = inspectReviewHop({
    stage: "REVIEW",
    outputDir: outDir,
    idempotencyKey: "w:T:REVIEW:1",
    waveId: "w",
    ticketId: "T",
    attempt: 1,
    forgeRoot: forge,
  });
  assert.equal(truth.status, "unknown");
});

test("resolve_grok_launcher defaults jam builder when env empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "wr052-launch-"));
  const fake = join(dir, "run_detached_builder.sh");
  writeFileSync(fake, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(fake, 0o755);
  const got = spawnSync(
    "bash",
    [
      "-c",
      'set -euo pipefail; unset WAVE_RUNNER_LAUNCHER; DEFAULT_GROK_LAUNCHER="$2"; source "$1"; resolve_grok_launcher; printf "%s" "$WAVE_RUNNER_LAUNCHER"',
      "_",
      healthSh,
      fake,
    ],
    { encoding: "utf8" },
  );
  assert.equal(got.status, 0, `${got.stderr}\n${got.stdout}`);
  assert.equal(got.stdout, fake);
});

test("resolve_grok_launcher keeps explicit WAVE_RUNNER_LAUNCHER", () => {
  const got = spawnSync(
    "bash",
    [
      "-c",
      'set -euo pipefail; source "$1"; WAVE_RUNNER_LAUNCHER=/tmp/explicit; resolve_grok_launcher; printf "%s" "$WAVE_RUNNER_LAUNCHER"',
      "_",
      healthSh,
    ],
    { encoding: "utf8" },
  );
  assert.equal(got.status, 0, got.stderr);
  assert.equal(got.stdout, "/tmp/explicit");
});
