import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { landPushEnv } from "../src/adapters/worktree-commit.js";
import { normalizeSelectedDependencies } from "../src/core/manifest.js";
import { acpTimeoutSeconds, DEFAULT_IMPL_WALL_MS } from "../src/core/stage-watchdog.js";
import type { FrozenTicket } from "../src/domain/types.js";

test("landPushEnv strips GH_TOKEN", () => {
  const env = landPushEnv({ GH_TOKEN: "nope", PATH: "/bin", HOME: "/tmp" });
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.PATH, "/bin");
});

test("acpTimeoutSeconds follows IMPL wall; 0 → 7d", () => {
  assert.equal(acpTimeoutSeconds("IMPL", {}), DEFAULT_IMPL_WALL_MS / 1000);
  assert.equal(acpTimeoutSeconds("IMPL", { WAVE_IMPL_WALL_MS: "0" }), 7 * 24 * 60 * 60);
  assert.equal(acpTimeoutSeconds("PLAN", { WAVE_PLAN_WALL_MS: "120000" }), 120);
});

test("openclaw-acp never sends sessions_spawn timeout fields", () => {
  const src = readFileSync("src/adapters/openclaw-acp.ts", "utf8");
  assert.match(src, /rejects per-call timeoutSeconds/);
  assert.doesNotMatch(src, /timeoutSeconds:\s/);
});

test("wave-operator writes WAVE_RESULT on WAVE_OK", () => {
  const sh = readFileSync("scripts/wave-operator.sh", "utf8");
  assert.match(sh, /write_wave_result/);
  assert.match(sh, /WAVE_RESULT\.json/);
  assert.match(sh, /from-inspect/);
});

test("run-backlog-wave surfaces missing_dependency skip reason", () => {
  const sh = readFileSync("scripts/run-backlog-wave.sh", "utf8");
  assert.match(sh, /missing_dependency/);
  assert.match(sh, /Open dependency/);
});

function frozen(ticketId: string, dependsOn: string[]): FrozenTicket {
  return {
    ticketId,
    title: ticketId,
    contentHash: "h",
    dependsOn,
    order: 1,
    sourcePath: `issues/${ticketId}.md`,
  };
}

test("normalizeSelectedDependencies: duplicate catalog any-terminal-wins", () => {
  const selected = [frozen("RRT-064", ["RRT-063"])];
  const doneLast = normalizeSelectedDependencies(selected, [
    { ticketId: "RRT-064", status: "open" },
    { ticketId: "RRT-063", status: "in_progress" },
    { ticketId: "RRT-063", status: "done" },
  ]);
  assert.deepEqual(doneLast[0]?.dependsOn, []);
  const doneFirst = normalizeSelectedDependencies(selected, [
    { ticketId: "RRT-064", status: "open" },
    { ticketId: "RRT-063", status: "done" },
    { ticketId: "RRT-063", status: "plan_review" },
  ]);
  assert.deepEqual(doneFirst[0]?.dependsOn, []);
  assert.throws(
    () =>
      normalizeSelectedDependencies(selected, [
        { ticketId: "RRT-064", status: "open" },
        { ticketId: "RRT-063", status: "open" },
        { ticketId: "RRT-063", status: "in_progress" },
      ]),
    /Open dependency RRT-063/,
  );
});
