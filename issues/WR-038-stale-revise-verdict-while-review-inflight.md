---
id: WR-038
title: Stale Crawmak revise verdict fail-closes while next REVIEW still in flight
status: done
priority: high
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
phase: ready
labels: [p0, plan-gate, review, crawmak, bug]
depends_on: [WR-028, WR-033]
related: [WR-010, WR-033, WR-037]
verify: npm test && npm run quality
verify_command: npm test && npm run quality
worker_out_dir: tmp/workers/WR-038
land: commit
---

# WR-038 — Stale revise verdict while REVIEW2 in flight

## Problem

Live SP2-046 wave `SP2-rent-train-w2-20260829091945` did the **one** allowed Crawmak revise bounce correctly, then died with `plan_review_revise_cap` **while REVIEW attempt 2 was still `LAUNCHED` / running**.

That is not “two revises by design.” It is admit re-reading a **stale** `Verdict: revise` from `crawmak/reviews/<TICKET>.md` (attempt 1) after `plan_review_revise` already counted once, before REVIEW2 could overwrite the file with `approve` / `approve-with-conditions`.

Jason 2026-08-29: file this as a Wave Runner bug and kick it.

## Observed timeline (SP2-046 w2)

1. PLAN1 → REVIEW1 → `revise`
2. One bounce: `REVISING` → PLAN2 *(allowed; cap default 1)*
3. `plan_review_launch` for planAttempt 2; REVIEW2 outbox **LAUNCHED**
4. Admit path still saw file verdict `revise` + `reviseCount >= 1` → **FAILED `plan_review_revise_cap`**
5. REVIEW2 never settled as the admitting verdict; later file could show `approve-with-conditions` after the ticket was already dead

Evidence paths:

- Wave out: `…/wave-runs/wave-sp2-rent-train-w2-20260829091945`
- Final tick stages: PLAN1 SUCCEEDED, REVIEW1 SUCCEEDED, PLAN2 SUCCEEDED, REVIEW2 LAUNCHED
- Events: one `plan_review_revise`, two `plan_review_launch` (attempts 1 and 2)
- Admit code: `src/core/plan-review-settle.ts` (`admitPlanReviewTicket`) + `src/core/plan-review.ts` (`checkPlanReview` reads single `reviews/<ID>.md`)

## Desired behavior

- Cap still means **at most one plan rewrite bounce** after an explicit Crawmak `revise`.
- While a **new REVIEW** is queued/running for a higher plan attempt, **do not** treat the previous attempt’s `revise` verdict as another revise (and do not fail-close on cap from that stale file).
- When REVIEW2 completes with `approve` / `approve-with-conditions`, admit IMPL (WR-033).
- When REVIEW2 completes with a **fresh** `revise` after the cap is already spent, then `plan_review_revise_cap` is correct.
- Prefer binding verdict to plan attempt / review stage-run (or ignore revise admit until in-flight REVIEW for current planAttempt settles). Do not require humans to delete `reviews/<ID>.md` between attempts.

## Acceptance

- [ ] Repro fixture or unit/integration test: after one `plan_review_revise`, with REVIEW attempt 2 in flight and disk verdict still `revise`, ticket does **not** go FAILED `plan_review_revise_cap`
- [ ] Same path: when REVIEW2 settles `approve` / `approve-with-conditions`, ticket becomes APPROVED / proceeds (no extra bounce)
- [ ] True second `revise` after cap still fails `plan_review_revise_cap`
- [ ] `npm test && npm run quality` green
- [ ] Commit-land WR `main` + push origin (this repo `land: commit`)

## Out of scope

- Changing default revise cap to >1
- Removing Crawmak bounce entirely
- Mona UX_REVIEW (WR-037) unless the same stale-file pattern exists there — fix both if shared helper, else note follow-up
- SP2 product impl

## Notes

- Design remains WR-028/WR-033 flow: PLAN → Crawmak → optional one REVISE → approve-class → IMPL.
- SP2-046/047 retry is a separate jam wave; this ticket is the WR fix so the race cannot strand a green second review.

## Closeout

Landed via worktree recovery `d848ab1` after worker-succeeded / stale_fence land miss. Verified `npm test && npm run quality`. Pushed origin.
