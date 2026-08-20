---
id: WR-024
title: Apply closeout skips BOARD.md 3-way merge
status: done
priority: crit
created: 2026-08-19
updated: 2026-08-19
source: jason
assignee: crawmak
builder: crawmak
worker: grok
preferred_model: grok
agent_eligible: true
eligibility: agent_eligible
needs_jason: false
phase: done
labels: [p0, apply, board, closeout]
depends_on: [WR-022]
related: [WR-016, WR-022, WR-023]
verify: npm test && npm run quality
verify_command: npm test && npm run quality
worker_out_dir: tmp/workers/WR-024
plan: plans/2026-08-19-wr-024-apply-skip-board-projection.md
land: commit
---

# WR-024 — BOARD.md is a projection; do not 3-way it

Live fail `BL-20260819155318` MUD-039: PLAN+IMPL green, then `APPLY_CONFLICT: issues/BOARD.md`. Product bytes sat in the worktree. Astra left WR and went back to Crawmak stamp theater.

BOARD.md is rewritten by every ticket. Dirty primary + worker board edit always conflicts. WR-016: board is not authority.

## Goals

1. Apply 3-way skips `issues/BOARD.md` (any depth). After product paths succeed, `markBoardDone` on **primary**.
2. BOARD-only divergence is not `APPLY_CONFLICT`. Real product conflicts still fail.
3. `npm test && npm run quality`; land commit + push.
