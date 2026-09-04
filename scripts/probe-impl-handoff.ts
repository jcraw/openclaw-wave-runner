#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";

import {
  extractImplContract,
  implContractRequired,
} from "../src/core/impl-contract.js";
import { stageBrief } from "../src/adapters/stage-briefs.js";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return undefined;
}

const reviewPath = arg("review");
if (!reviewPath || !existsSync(reviewPath)) {
  process.stderr.write("usage: probe-impl-handoff --review <reviews/ID.md> [--plan PLAN.md]\n");
  process.exit(2);
}

const text = readFileSync(reviewPath, "utf8");
const extracted = extractImplContract(text);
const verdictMatch = text.match(
  /(?:^|\n)\s*(?:\*\*)?Verdict(?:\*\*)?:\s*(?:\*\*)?\s*(approve-with-conditions|approve|revise)\b/i,
);
const verdict = verdictMatch?.[1]?.toLowerCase() ?? "";
const required = implContractRequired(verdict);
const wouldAdmit = verdict === "approve" || (required && extracted.ok);
const reason = extracted.ok ? "" : extracted.reason;
const chars = extracted.ok ? extracted.body.length : 0;
const brief = stageBrief(
  {
    idempotencyKey: "probe:T:IMPL:1",
    waveId: "probe",
    ticketId: "T",
    stage: "IMPL",
    attempt: 1,
    prompt: "IMPL T",
    sessionKey: "probe-session",
    outputDir: "/tmp/probe-impl",
    approvedPlanPath: arg("plan"),
  },
  "/tmp/probe-impl",
);

process.stdout.write(
  `${JSON.stringify(
    {
      verdict,
      required,
      would_admit: wouldAdmit,
      chars,
      reason,
      brief_head: brief.split("\n").slice(0, 12).join("\n"),
    },
    null,
    2,
  )}\n`,
);
process.exit(wouldAdmit ? 0 : 1);
