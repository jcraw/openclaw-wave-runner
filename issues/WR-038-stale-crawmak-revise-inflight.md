---
id: WR-038
title: Stale Crawmak revise must not fail-close an in-flight re-review
status: impl
priority: crit
created: 2026-08-29
updated: 2026-08-29
source: jason
assignee: crawmak
builder: crawmak
worker: grok
preferred_model: grok
agent_eligible: true
eligibility: agent_eligible
needs_jason: false
phase: impl
labels: [p0, plan-gate, review, crawmak]
depends_on: [WR-028, WR-033]
related: [WR-037]
verify: npm test && npm run quality
verify_command: npm test && npm run quality
worker_out_dir: tmp/workers/WR-038
plan: plans/2026-08-29-wr-038-stale-revise-inflight.md
land: commit
plan_review: skip
---

# WR-038 — Stale Crawmak revise must not fail-close an in-flight re-review

`reviews/<TICKET>.md` is hop-global. After hop 1 `Verdict: revise`, PLAN 2 and REVIEW 2 launch, but `admitPlanReviewTicket` still reads hop 1's `revise` and fail-closes `plan_review_revise_cap` while REVIEW 2 is in flight.

## Acceptance

- [x] Do not call `checkPlanReview` / act on the forge verdict unless this hop is review-ready: hop launch for `latestPlanAttempt` **and** REVIEW outbox not open **and** REVIEW stage not busy.
- [x] In-flight REVIEW 2 stays `PLAN_REVIEW`. No `plan_review_revise_cap`. No IMPL. No second `plan_review_revise`.
- [x] Hop-2 approve-class after REVIEW 2 settles admits (`plan_review_admit`). Not cap.
- [x] Real second revise after REVIEW 2 **succeeds** still hits `plan_review_revise_cap`.
- [x] Leftover Astra/Jason stamp with no Crawmak launch still admits. Skip-bit untouched.
- [x] `npm test && npm run quality`. Commit-land this worktree.

## Non-goals

Raising the default revise cap. Binding the forge file by mtime/hash. UX_REVIEW product change. Deploy, push, merge, Gateway.
