---
id: WR-029
title: End-to-end closeout — apply overwrite, push without GH_TOKEN, keep tickets in the machine
status: done
priority: crit
created: 2026-08-22
updated: 2026-08-22
source: jason
assignee: crawmak
builder: crawmak
worker: grok
preferred_model: grok
agent_eligible: true
eligibility: agent_eligible
needs_jason: false
phase: done
labels: [p0, apply, closeout, land, select, acp]
depends_on: [WR-026]
related: [WR-022, WR-023, WR-027, WR-028]
verify: npm test && npm run quality
verify_command: npm test && npm run quality
worker_out_dir: tmp/workers/WR-029
plan: plans/2026-08-22-wr-029-e2e-apply-overwrite-closeout.md
land: commit
---

# WR-029 — Make supervised waves finish in the codebase

Live failures: RRT-060 `APPLY_CONFLICT` after green verify; WR-027 push 403; RRT-062 `plan_review` dropped from select; ACP 3600s killing IMPL; 061 `WAVE_OK` with no `WAVE_RESULT.json`.

## Acceptance

- [x] Apply mode copies incoming worktree bytes onto primary (overwrite). No `git merge-file`. BOARD still projection-only.
- [x] Land push unsets `GH_TOKEN`.
- [x] Select includes `plan_review` / `planning` (and `implementing`).
- [x] ACP spawn timeout follows `WAVE_PLAN_WALL_MS` / `WAVE_IMPL_WALL_MS` (0 → 7d).
- [x] `wave-operator.sh` writes `WAVE_RESULT.json` on terminal.
- [x] `npm test && npm run quality`; commit-land + push origin.
