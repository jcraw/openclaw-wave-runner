import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { describeReplacementPath } from "../src/adapters/studio.js";
import { SAFETY, assertBoundedWaveRequest } from "../src/domain/safety.js";
import { SafetyGateError } from "../src/domain/errors.js";
import { capabilities } from "../src/core/wave-projection.js";
import type { ControllerContext } from "../src/core/controller-context.js";

test("WR-034: default shell wall is 0; FATAL wall remains; OVERNIGHT is an alias", () => {
  const wave = readFileSync("scripts/run-backlog-wave.sh", "utf8");
  assert.match(wave, /WALL_S=0/);
  assert.doesNotMatch(wave, /21600/);
  assert.match(wave, /FATAL wall/);
  assert.match(wave, /"\$WALL_S" != "0"/);
  assert.match(wave, /OVERNIGHT is not a mode; use WAVE_WALL_S=0/);
  assert.match(wave, /WALL_S="\$WAVE_WALL_S"/);
  assert.match(wave, /OVERNIGHT:-0/);
});

test("WR-034: drain banner has no OVERNIGHT=; does not unset or default-export it", () => {
  const drain = readFileSync("scripts/drain-eligible.sh", "utf8");
  assert.doesNotMatch(drain, /echo "=== drain-eligible start.*OVERNIGHT=/);
  assert.doesNotMatch(drain, /OVERNIGHT="\$\{OVERNIGHT:-0\}"/);
  assert.doesNotMatch(drain, /^unset OVERNIGHT/m);
  assert.doesNotMatch(drain, /^export OVERNIGHT/m);
  assert.match(drain, /WALL_S=\$WALL_S MAX_PARALLEL/);
  assert.match(drain, /Do not default or export OVERNIGHT/);
});

test("WR-034: overnight:true always throws; operatorOvernight escape is gone", () => {
  assert.equal(SAFETY.overnightEnabled, false);
  assert.equal(SAFETY.autonomousOvernightEnabled, false);
  assert.equal("operatorOvernightDrainAllowed" in SAFETY, false);
  assert.throws(
    () => assertBoundedWaveRequest({ overnight: true, ticketIds: ["T-1"] }),
    SafetyGateError,
  );
  assert.doesNotThrow(() => assertBoundedWaveRequest({ ticketIds: ["T-1"] }));
});

test("WR-034: replacement copy is not a clock-time mode; pins stay off", () => {
  const replacement = describeReplacementPath();
  assert.match(replacement.overnight, /unprompted/i);
  assert.match(replacement.overnight, /no clock-time mode/i);
  assert.doesNotMatch(replacement.overnight, /daytime/i);
  const caps = capabilities({} as ControllerContext);
  assert.equal(caps.overnightEnabled, false);
  assert.equal(SAFETY.overnightEnabled, false);
});
