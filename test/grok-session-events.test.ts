import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  grokCwdHasHungReadFile,
  receiptHasHungReadFile,
  worktreeFromOutputDir,
} from "../src/adapters/grok-session-events.js";

test("worktreeFromOutputDir strips tmp/wave-runs", () => {
  const wt = "/run/media/j/data/worktrees/SP2-014";
  assert.equal(
    worktreeFromOutputDir(`${wt}/tmp/wave-runs/WAVE/SP2-014/IMPL/2`),
    wt,
  );
  assert.equal(worktreeFromOutputDir("/tmp/nope"), undefined);
});

test("grokCwdHasHungReadFile reads events.jsonl under encoded cwd", () => {
  const home = mkdtempSync(join(tmpdir(), "grok-home-"));
  const cwd = "/tmp/isolated/SP2-014";
  const session = join(home, "sessions", encodeURIComponent(cwd), "sess-1");
  mkdirSync(session, { recursive: true });
  const t0 = "2026-08-24T20:15:25.808Z";
  writeFileSync(
    join(session, "events.jsonl"),
    `${JSON.stringify({ ts: t0, type: "tool_started", tool_name: "read_file" })}\n`,
    "utf8",
  );
  const now = Date.parse(t0) + 60_000;
  assert.equal(grokCwdHasHungReadFile(cwd, now, 60_000, home), true);
  assert.equal(grokCwdHasHungReadFile(cwd, Date.parse(t0) + 1_000, 60_000, home), false);
  assert.equal(
    receiptHasHungReadFile({ idempotencyKey: "k", cwd }, now, 60_000, home),
    true,
  );
  assert.equal(grokCwdHasHungReadFile("/tmp/missing", now, 60_000, home), false);
});
