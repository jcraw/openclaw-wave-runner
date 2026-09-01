---
id: WR-040
title: PLAN fail must not apply; Codex ACP_TURN_FAILED is not a Grok fallback
status: done
priority: crit
created: 2026-09-01
updated: 2026-09-01
source: jason
assignee: crawmak
builder: crawmak
worker: grok
preferred_model: grok
agent_eligible: true
eligibility: agent_eligible
needs_jason: false
phase: impl
labels: [p0, operator, hybrid, apply]
depends_on: [WR-035, WR-037, WR-039]
related: [WR-022, WR-023]
verify: npm test && npm run quality
verify_command: npm test && npm run quality
land: commit
plan_review: skip
---

# WR-040 — PLAN-fail false land; Codex ACP_TURN_FAILED

`wave-sp2-remain-20260831232437` batch 2 (SP2-063/064) died in 90s: Codex ACP PLAN `ACP_TURN_FAILED: Internal error` ×3, then apply-mode stamped SP2-063 **done** (board-only `c545a7da`). 064 blocked. A later grok-PLAN re-kick landed both. RRT-120–122 (grok) completed in the same window.

Batch 1 (054/055/062) grok PLAN landed, but sqlite `needsUx` flipped true→false mid-REVIEW so Mona hops never ran. Freeze manifest still had `needsUx: true`.

## Acceptance

- [x] Codex PLAN `ACP_TURN_FAILED` is not retried (fail once). Hybrid still launches Codex (WR-041 undid drain-refuse).
- [x] Apply-on-exhausted copies **only** after a settled IMPL. PLAN fail must not stamp BOARD/issue done.
- [x] Plan-gate UX decisions OR freeze `needsUx` with the live row so a sqlite flip cannot skip Mona.
- [x] `npm test` green. Quality may stay red on pre-existing `openclaw-acp.ts` baseline.

## Non-goals

- Grok fallback if Codex spawn is refused (WR-035 D8).
- Routing IMPL to Codex.
- Raising `maxRetriesPerStage`.
