---
id: WR-018
title: Audit fix — quality green, persist scope/hold, stop safety lies
status: done
priority: high
created: 2026-08-16
updated: 2026-08-16
source: jason
agent_eligible: true
eligibility: agent_eligible
depends_on: []
verify: npm run quality
labels: [quality, safety, schema, mutation]
---

# WR-018 — Audit remediations

## Problem
Crawmak project audit (`crawmak/reviews/WR-AUDIT.md`, 2026-08-16): control plane is sound, tests pass (114/114), but **`npm run quality` is red on `main`**, docs quote a stale mutation score, schema drops WR-008/011 fields, and a few safety surfaces lie.

## Goal
Make the advertised quality/safety story true of current `main`. One impl. No architecture rewrite.

## Acceptance
- [x] `npm run quality` exit 0 on a clean tree
- [x] `npm run mutation` exit 0 without EISDIR; break stays 80; live score recorded (not 92.72%)
- [x] No host-absolute home paths in tracked scripts
- [x] `settlement.ts` under token error ceiling without waiving it; `mocks.ts` not over its baseline
- [x] `ticket_runs` round-trips `writerScope`, `humanHold`, `humanHoldReason`, `product`, `game`
- [x] Restart/reopen-db test: explicit `writerScope` that does **not** match `sourcePath` survives
- [x] `wave_runner.capabilities` does not contradict `SAFETY`
- [x] Land push never uses a repo-path heuristic; no push unless explicit operator intent
- [x] Missing `verifyCommand` does not default to shell `true`
- [x] `fencingGeneration` checked before IMPL settle/land
- [x] Docs match: QUALITY-GATES score/baselines, README writer-lease invariant, runbook supervised path

## Owning paths
See plan `plans/2026-08-16-wr-018-audit-fix.md`.

## Related
- WR-017 owns land **reliability** (identity, DONE without LAND.json, hanging worktrees). Do not absorb it.
- WR-002 mutation surface stays three pure files. Do not widen to chase %.

## Agent notes
Substantial: PLAN → Crawmak review → Astra stamp → fresh IMPL.
Verify: `npm run quality`. Public package; push after land.
