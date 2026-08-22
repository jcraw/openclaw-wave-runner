import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { landPushEnv } from "../src/adapters/worktree-commit.js";
import { acpTimeoutSeconds, DEFAULT_IMPL_WALL_MS } from "../src/core/stage-watchdog.js";

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

test("wave-operator writes WAVE_RESULT on WAVE_OK", () => {
  const sh = readFileSync("scripts/wave-operator.sh", "utf8");
  assert.match(sh, /write_wave_result/);
  assert.match(sh, /WAVE_RESULT\.json/);
  assert.match(sh, /from-inspect/);
});
