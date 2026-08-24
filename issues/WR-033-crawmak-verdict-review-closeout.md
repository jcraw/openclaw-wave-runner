---
id: WR-033
title: Crawmak verdict is the plan gate; REVIEW inspect; no budget_open throw
status: done
priority: crit
created: 2026-08-24
updated: 2026-08-24
source: jason
assignee: crawmak
builder: crawmak
worker: grok
preferred_model: grok
agent_eligible: true
eligibility: done
needs_jason: false
phase: done
labels: [p0, plan-gate, review, closeout]
depends_on: [WR-028, WR-032]
related: [WR-015, WR-028]
verify: npm test && npm run quality
verify_command: npm test && npm run quality
worker_out_dir: tmp/workers/WR-033
land: commit
plan_review: skip
---

# WR-033 — Crawmak verdict admits; REVIEW closeout must not kill the drain

Jason 2026-08-24: he does not approve plans. Spikes/`needs_jason` are the only human hold. Crawmak review Verdict is the approve. Live drains (RRT-086/087/088, GS-155/157, SP2-012) applied product then died on `budget_open` because REVIEW `terminal.json` was inspected as PLAN.

## Acceptance

- [x] `inspectReceiptArtifacts` parses `REVIEW` (same as grok-cli). Matching REVIEW `terminal.json` is succeeded.
- [x] `maybeCompleteWave` marks leftover `RESERVED` budgets `INDETERMINATE` when every ticket is terminal. Does not throw `budget_open`.
- [x] Crawmak Verdict `approve` / `approve-with-conditions` ledger-approves. No Astra/Jason plan stamp required. Revise and `needs_jason` unchanged. Do not bash-stamp Astra.
- [x] `OVERNIGHT=1` (or `WAVE_WALL_S=0`) lifts the 6h shell wall. Operator tick-fail uses a 5-streak, not first-fail exit.
- [x] `npm test && npm run quality`. Commit-land WR `main` + push origin.

## Non-goals

Unrestricted autonomous overnight. Inventing Astra. Cancelling live hung waves (next tick after this land should COMPLETE).
