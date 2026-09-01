---
id: WR-039
title: Launch cap must cover hops; tick must not die at max_launches
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
labels: [p0, budget, operator, overnight]
depends_on: [WR-012, WR-037]
related: [WR-028, WR-033]
verify: npm test && npm run quality
verify_command: npm test && npm run quality
land: commit
plan_review: skip
---

# WR-039 — Launch cap must cover hops; tick must not die at max_launches

SP2-b1-doors-bugs-train (8 tickets, all `needs_ux`) died twice on `max_launches=10`, then 054/055/062 Codex PLAN `ACP_TURN_FAILED`. Operator `repeated_tick_fail` after the tick threw `AdmissionDeniedError`.

## Acceptance

- [x] Happy-path hops = PLAN + Crawmak REVIEW (unless skip) + Mona UX (if `needs_ux`) + IMPL. Supervised default `maxLaunches` is `SAFETY.supervisedMaxLaunches` (48), enough for 8×4.
- [x] Dry-run emits `hops_exceed_max_launches`; `run-backlog-wave.sh` preflight-fails it. Do not create an overnight wave that cannot finish.
- [x] Idle `max_launches` / token ceiling → `BUDGET_STOPPED`. Do **not** throw out of `tick` (that is `OPERATOR_STOP repeated_tick_fail`). In-flight work is not killed.
- [x] Record `plan_review_launch` / `ux_review_launch` **after** `queueStage` succeeds. A failed admit must not skip the hop forever.
- [x] `npm test` 314 pass. `npm run quality` still red on pre-existing `openclaw-acp.ts` 2561 > baseline 2380 (untouched this ticket).
