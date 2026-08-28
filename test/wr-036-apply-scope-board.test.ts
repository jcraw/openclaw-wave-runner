import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyToWorkdir, isApplyScopedPath } from "../src/adapters/apply-workdir.js";
import { git, stampBoardText } from "../src/adapters/land-git.js";
import { GitWorkspace } from "../src/adapters/workspace.js";
import { applyAllowPrefixes } from "../src/domain/scope-paths.js";

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wave-wr036-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "wave@example.test"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Wave Runner"], { cwd: dir });
  mkdirSync(join(dir, "issues", "spare_parts_2"), { recursive: true });
  mkdirSync(join(dir, "game", "jams", "spare_parts_2"), { recursive: true });
  mkdirSync(join(dir, "android", "build"), { recursive: true });
  writeFileSync(join(dir, "game", "jams", "spare_parts_2", "keep.gd"), "old\n", "utf8");
  writeFileSync(join(dir, "android", "build", "config.gradle"), "minSdk 26\n", "utf8");
  writeFileSync(
    join(dir, "issues", "spare_parts_2", "SP2-026-warehouse-door.md"),
    `---
id: SP2-026
status: open
---
# SP2-026
`,
    "utf8",
  );
  writeFileSync(
    join(dir, "issues", "BOARD.md"),
    "- **SP2-026 open · hybrid · not kicked · high** — door\n",
    "utf8",
  );
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

async function makeTree(repo: string) {
  const ws = new GitWorkspace();
  const created = await ws.createImplWorktree({
    repoPath: repo,
    baseSha: git(repo, ["rev-parse", "HEAD"]),
    waveId: "w1",
    ticketId: "SP2-026",
    worktreeRoot: join(repo, "tmp", "worktrees"),
  });
  return { ...created, baseSha: git(repo, ["rev-parse", "HEAD"]) };
}

test("stampBoardText: house row open · worker · not kicked", () => {
  const house = "- **SP2-026 open · hybrid · not kicked · high** — door\n";
  const { next, changed } = stampBoardText(house, "SP2-026");
  assert.equal(changed, true);
  assert.equal(next, "- **SP2-026 done · hybrid · high** — door\n");
});

test("stampBoardText: legacy **ID open** still stamps", () => {
  const { next, changed } = stampBoardText("- **FX-101 open** fixture\n", "FX-101");
  assert.equal(changed, true);
  assert.equal(next, "- **FX-101 done** fixture\n");
});

test("stampBoardText: missing row is a no-op", () => {
  const { next, changed } = stampBoardText("- **SP2-024 done · grok · high** — old\n", "SP2-026");
  assert.equal(changed, false);
  assert.equal(next, "- **SP2-024 done · grok · high** — old\n");
});

test("applyAllowPrefixes: game scope includes jam + issues board", () => {
  assert.deepEqual(applyAllowPrefixes("game:spare_parts_2", "issues/spare_parts_2/SP2-026.md"), [
    "game/jams/spare_parts_2/",
    "issues/spare_parts_2/",
  ]);
  assert.deepEqual(applyAllowPrefixes("prefix:WR"), []);
});

test("isApplyScopedPath: empty prefixes unrestricted except BOARD", () => {
  assert.equal(isApplyScopedPath("android/build/config.gradle", { prefixes: [], ticketId: "FX-101" }), true);
  assert.equal(isApplyScopedPath("issues/BOARD.md", { prefixes: [], ticketId: "FX-101" }), false);
});

test("apply game scope copies jam+issue; skips android overlay", async () => {
  const repo = initRepo();
  const { worktree, baseSha } = await makeTree(repo);
  writeFileSync(join(worktree, "game", "jams", "spare_parts_2", "keep.gd"), "new\n", "utf8");
  writeFileSync(
    join(worktree, "issues", "spare_parts_2", "SP2-026-warehouse-door.md"),
    `---
id: SP2-026
status: in_progress
---
# SP2-026
`,
    "utf8",
  );
  writeFileSync(join(worktree, "android", "build", "config.gradle"), "minSdk 24\n", "utf8");
  writeFileSync(join(worktree, "stray.txt"), "nope\n", "utf8");
  const applied = await applyToWorkdir({
    repoPath: repo,
    worktree,
    ticketId: "SP2-026",
    waveId: "w1",
    baseSha,
    writerScope: "game:spare_parts_2",
    sourcePath: "issues/spare_parts_2/SP2-026-warehouse-door.md",
  });
  assert.equal(applied.ok, true, applied.error);
  assert.equal(readFileSync(join(repo, "game", "jams", "spare_parts_2", "keep.gd"), "utf8"), "new\n");
  assert.equal(readFileSync(join(repo, "android", "build", "config.gradle"), "utf8"), "minSdk 26\n");
  assert.equal(existsSync(join(repo, "stray.txt")), false);
  assert.ok((applied.skipped ?? []).includes("android/build/config.gradle"));
  assert.ok((applied.skipped ?? []).includes("stray.txt"));
  const board = readFileSync(join(repo, "issues", "BOARD.md"), "utf8");
  assert.match(board, /\*\*SP2-026 done · hybrid · high\*\*/);
  assert.doesNotMatch(board, /not kicked/);
  assert.match(readFileSync(join(repo, "issues", "spare_parts_2", "SP2-026-warehouse-door.md"), "utf8"), /status: done/);
  const proof = JSON.parse(readFileSync(applied.proof, "utf8")) as { skipped?: string[] };
  assert.ok((proof.skipped ?? []).includes("android/build/config.gradle"));
});
