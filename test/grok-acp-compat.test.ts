import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const src = readFileSync(join(process.cwd(), "scripts/grok-acp-compat.mjs"), "utf8");

test("grok-acp-compat attaches crawmak --agent-profile when profile exists", () => {
  assert.match(src, /--agent-profile/);
  assert.match(src, /GROK_AGENT_PROFILE/);
  assert.match(src, /crawmak/);
  assert.match(src, /profile\.md/);
  assert.doesNotMatch(src, /\/run\/media\//);
  assert.match(src, /existsSync\(DEFAULT_AGENT_PROFILE\)/);
});
