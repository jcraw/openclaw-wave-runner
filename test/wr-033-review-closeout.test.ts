import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  inspectReceiptArtifacts,
  writeStageTerminal,
} from "../src/adapters/stage-artifacts.js";
import { parseStageFromIdempotencyKey } from "../src/core/stage-paths.js";
import { maybeCompleteWave } from "../src/core/tick.js";
import { TICKET_NEXT, TICKET_OWNERS } from "../src/core/state-machine.js";
import { createSimulator, seedWave } from "../src/sim/simulator.js";

test("parseStageFromIdempotencyKey keeps REVIEW (not PLAN)", () => {
  const parsed = parseStageFromIdempotencyKey("BL-RRT-086:RRT-086:REVIEW:1");
  assert.equal(parsed.stage, "REVIEW");
  assert.equal(parsed.ticketId, "RRT-086");
  assert.equal(parsed.attempt, 1);
  assert.equal(parseStageFromIdempotencyKey("w:T:IMPL:2").stage, "IMPL");
  assert.equal(parseStageFromIdempotencyKey("w:T:PLAN:1").stage, "PLAN");
});

test("inspectReceiptArtifacts: REVIEW terminal.json is succeeded", () => {
  const dir = mkdtempSync(join(tmpdir(), "wr033-review-"));
  const key = "BL-RRT-086-x:RRT-086:REVIEW:1";
  writeStageTerminal(dir, {
    idempotencyKey: key,
    waveId: "BL-RRT-086-x",
    ticketId: "RRT-086",
    stage: "REVIEW",
    attempt: 1,
    status: "succeeded",
    artifact: "terminal.json",
  });
  const truth = inspectReceiptArtifacts({ idempotencyKey: key, outputDir: dir });
  assert.equal(truth?.status, "succeeded");
});

test("maybeCompleteWave: leftover REVIEW RESERVED → COMPLETED, not budget_open", async () => {
  const sim = createSimulator("wr033-budget-open");
  const waveId = "wave-leftover-review";
  const controller = await seedWave(sim, waveId, ["FX-001"], { maxTokens: 80_000, maxLaunches: 8 });
  await controller.start(waveId);
  const ticket = controller.db.getTicket(waveId, "FX-001");
  assert.ok(ticket);
  ticket.status = "DONE";
  ticket.owner = TICKET_OWNERS.DONE;
  ticket.nextAction = TICKET_NEXT.DONE;
  ticket.revision += 1;
  controller.db.putTicket(ticket);
  controller.db.putBudget({
    budgetId: `${waveId}:bdg:review-leftover`,
    waveId,
    tokensReserved: 8000,
    costReservedMicros: 0,
    state: "RESERVED",
    createdAt: 1,
    updatedAt: 1,
  });
  assert.doesNotThrow(() => maybeCompleteWave(controller, waveId));
  const view = controller.inspect(waveId);
  assert.equal(view.wave.status, "COMPLETED");
  assert.ok(view.budgets.every((b) => b.state !== "RESERVED"));
});
