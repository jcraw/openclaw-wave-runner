---
id: WR-052
title: Grok REVIEW hop must grok-cli + admit on crawmak/reviews/<ID>.md
plain: After PLAN, Crawmak REVIEW dies (ACP agent grok missing, grok-cli maps REVIEW to planning, inspect wants terminal.json). Future named waves never leave PLAN_REVIEW.
status: done
priority: crit
created: 2026-09-08
updated: 2026-09-08
source: jason
assignee: crawmak
builder: crawmak
worker: grok
preferred_model: grok
agent_eligible: true
eligibility: agent_eligible
needs_jason: false
labels: [p0, review, grok-cli, crawmak]
depends_on: []
related: [WR-028, WR-033, WR-051, CA-018]
verify: npm test && npm run quality
verify_command: npm test && npm run quality
land: commit
phase: done
plan: plans/2026-09-08-wr-052-grok-review-cli-admit.md
---

# WR-052 — Grok REVIEW hop actually admits

Jason 2026-09-08: always Wave Runner for named tickets (N=1 is a wave). REVIEW hop is why WR “doesn’t work.” Do not babysit MC-006.

## Incident (live)

`wave-rrt-bugs-sequential-202609072022` RRT-136: PLAN `SUCCEEDED` via grok-cli; REVIEW `FAILED` / `retry 2 after: stage_watchdog: REVIEW hung`. No `crawmak/reviews/RRT-136.md`. Supervisor live, `WAVE_RUNNER_LAUNCHER` empty → ticks have no `--launcher` → Grok REVIEW is ACP `sessions_spawn` agent `grok` → `Unknown agent id "grok"`.

Even with launcher: `GrokCliWorker` maps non-IMPL to jam `--phase planning` and `PLAN_BRIEF.md` (RRT-016). `inspectStageArtifacts` REVIEW = matching `terminal.json` only; forge `reviews/<ID>.md` is ignored.

## Goal

Named-ticket waves walk PLAN → Crawmak REVIEW → IMPL without Astra/kick.sh. Grok REVIEW is grok-cli (unless OpenClaw lists agent `grok`). Inspect succeeds on an admit-ready `reviews/<ID>.md` (or matching terminal). Default launcher is jam `run_detached_builder.sh` when that file is executable.

## Acceptance

- [x] Grok REVIEW launch: jam `--phase reviewing`, `--repo` = forge cwd, `REVIEW_BRIEF.md` (not `planning` / `PLAN_BRIEF.md`)
- [x] Inspect REVIEW: `checkPlanReview` ok (approve / approve-with-conditions / revise) **or** matching `terminal.json` → succeeded
- [x] `WAVE_RUNNER_LAUNCHER` empty + jam builder executable → supervisor/operator/backlog ticks pass `--launcher`
- [x] Do **not** skip REVIEW launch because a stale `reviews/<ID>.md` exists (WR-038)
- [x] Tests for launch argv + inspect-without-terminal. `npm test && npm run quality`. Commit-land + push origin

## Non-goals

MC-006 product. Mona UX. `kick.sh --phase review`. `openclaw.json` grok agent. Live supervisor respawn. Unrestricted drain.
