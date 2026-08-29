# WR-038 plan — Stale Crawmak revise must not fail-close an in-flight re-review

**Ticket:** WR-038 (no `issues/WR-038-*.md` in this freeze; IMPL adds one)
**Verify:** `npm test && npm run quality`
**Land:** commit this worktree (no push/merge/Gateway from this ticket)
**Author:** `JCraw <4335668+jcraw@users.noreply.github.com>`

Depends on WR-028 (Crawmak `REVIEW` stage) and WR-033 (Crawmak approve-class **is** ledger-approve). WR-037 already hop-keys **launch** of the next Crawmak review (`hasHopLaunch(..., planAttempt)`); admit of the forge file does not.

## Problem

`reviews/<TICKET>.md` is a single path. After hop 1 `Verdict: revise`:

1. `admitPlanReviewTicket` emits `plan_review_revise`, ticket → `REVISING`.
2. PLAN attempt 2 succeeds → `PLAN_REVIEW`, wave `AWAITING_PLAN_GATE`.
3. `queueMissingPlanReviews` hop-keys correctly and launches REVIEW 2 (`planAttempt` 2).
4. Same tick and every later tick while REVIEW 2 is open, `maybeAdmitPlanGate` → `admitPlanReviewTicket` reads the **hop-1** file, still `revise`.
5. `reviseCount >= planReviewReviseCap` (default 1) → `FAILED` `plan_review_revise_cap`.

`tickWave` order makes this mechanical: `queueMissingPlanReviews` then `maybeAdmitPlanGate` (`src/core/tick.ts`). Settlement of REVIEW 2 is not required for the fail-close.

`test/wr-028-plan-review.test.ts` “verdict revise re-queues PLAN” stops at the first `plan_review_revise` and never `runUntilIdle`, so the cap race is untested. Mock `completeOnInspect` can also settle REVIEW 2 in the launch tick with the stale file still on disk; live ACP writes the new verdict only when REVIEW 2 finishes.

`admitUxReviewTicket` has the same shape for Mona `revise`, but WR-037’s `crawmakSatisfiedForHop` blocks UX admit until **this** hop’s Crawmak approve-class exists. This ticket is the Crawmak admit path.

## Goal

After a Crawmak `revise`, keep `PLAN_REVIEW` and let REVIEW 2 run. Do not treat hop 1’s `Verdict: revise` as hop 2’s verdict. A real second revise (REVIEW 2 **succeeded** and the forge file still says `revise`) still hits `plan_review_revise_cap`.

## Decisions

| # | Pick |
|---|---|
| D1 | In `admitPlanReviewTicket`, **do not** call `checkPlanReview` / act on forge verdict unless this hop is review-ready: `hasHopLaunch(plan_review_launch, latestPlanAttempt)` **and** not `openStageOutbox(..., "REVIEW")` **and** not `stageBusy(..., "REVIEW")`. Else return false (stay `PLAN_REVIEW`). Those three helpers already live in `src/core/ux-review-settle.ts` and are already used to **queue** reviews. |
| D2 | Settlement stays the admit path for a finished hop. `settleOutbox` `markSettled` + stage `SUCCEEDED` **before** `admitPlanReviewTicket` (`src/core/settlement.ts`). After that, outbox is not open and the stage is not busy, so D1 still admits hop 2. Do not require `REVIEW.attempt === planAttempt` (PLAN retries can desync those counters). Hop key is `plan_review_launch.planAttempt` from `latestPlanAttempt` (max succeeded PLAN). |
| D3 | Leftover Astra/Jason stamp path unchanged: `!hasLaunch && stamped && needsUx !== true`. D1 wraps **file verdict only**. A ticket that never launched Crawmak can still leftover-admit. After any `plan_review_launch`, leftover stays blocked (`hasLaunch`). |
| D4 | Cap semantics unchanged: default 1; ticket `planReviewReviseCap` overrides. Cap fail only after a **ready** hop whose forge file is still `revise`. Do not count in-flight REVIEW 2 as a second revise. Optional: add `planAttempt` to `plan_review_revise` payload (event id stays revision-keyed). |
| D5 | Approve-class on a ready hop unchanged (WR-033). `needs_ux` still returns false on Crawmak approve-class (Mona still required). Skip-bit / human hold / `plan_gate_auto` untouched. |
| D6 | Crawmak-only this ticket. Do not retune `admitUxReviewTicket` unless D1’s helper is a trivial shared predicate and existing WR-037 tests stay green without cap-semantic change. Follow-up if Mona stale-revise-while-`UX_REVIEW`-in-flight is still live after this land. |
| D7 | No schema, no new stage, no Gateway, no Astra stamp, no `kick.sh`. |

## Code

- `src/core/plan-review-settle.ts` — local `planReviewHopReady(...)` (or equivalent) used only on the `checkPlanReview` branch of `admitPlanReviewTicket`. Keep file under the 2500-token ceiling (`config/token-baseline.json`); this file is not allow-listed.
- `test/wr-038-stale-revise.test.ts` — named contracts below. Reuse `writeReview` / seed pattern from `test/wr-028-plan-review.test.ts`. Hang hop 2 with `MockWorker.hangPrefix` matching idempotency `:REVIEW:2` (see `test/wr-020-live-wave.test.ts`).
- `issues/WR-038-stale-crawmak-revise-inflight.md` — board ticket, `plan_review: skip` after land if this repo’s convention for self-work is skip-on-closeout; otherwise leave agent-eligible as Jason’s freeze set it. `verify: npm test && npm run quality`. `land: commit`.
- `plans/2026-08-29-wr-038-stale-revise-inflight.md` — copy of this plan at IMPL land.
- `docs/OPERATOR-RUNBOOK.md` — one sentence under the WR-028/033 plan-gate bullets: after Crawmak `revise`, the next hop’s REVIEW must settle before the forge file is read again; leftover `Verdict: revise` must not `plan_review_revise_cap` an in-flight re-review.

## Tests

1. **In-flight:** hop 1 `revise` → wait `plan_review_revise` → `hangPrefix` `:REVIEW:2` → ticks while REVIEW 2 is `LAUNCHED`/`CLAIMED`. Ticket stays `PLAN_REVIEW`. Result is not `plan_review_revise_cap`. No IMPL. No second `plan_review_revise`. Wave not terminal.
2. **Hop-2 approve:** after first revise, rewrite forge file to approve-class (cheat-mode + Learn present), clear hang, `runUntilIdle`. Ticket `DONE` (or `APPROVED` then IMPL). Event `plan_review_admit`. Not `plan_review_revise_cap`.
3. **Real second revise:** leave file as `revise`, do not hang, `runUntilIdle`. After REVIEW 2 **succeeds**, `FAILED` `plan_review_revise_cap`. No IMPL. Existing first-hop revise contract in wr-028 still holds (PLAN re-queued, no IMPL at first revise).
4. **Leftover stamp:** no Crawmak file / no launch, plan has `APPROVED by Jason` → still admits (wr-028 leftover). Skip-bit path untouched.

## Non-goals

- Raising the default revise cap.
- Binding the forge file by mtime/hash (live worker overwrites the same path; hop-ready is the gate).
- Requiring Astra/Jason stamps (WR-033 stands).
- UX_REVIEW product change (D6).
- REVIEW-fail retry / `hasHopLaunch` blocking a re-launch on the same `planAttempt` (pre-existing; not this fail-close).
- Deploy, push, merge, Gateway, SAFETY flips.

## Verify

`npm test && npm run quality` on this worktree HEAD. Named new tests in `test/wr-038-stale-revise.test.ts` plus existing `test/wr-028-plan-review.test.ts` and `test/wr-033-review-closeout.test.ts`.

## Learn

- bite: none
- candidate: Crawmak `reviews/<ID>.md` is hop-global; admit on `revise` without hop-ready + in-flight guard fail-closes the next REVIEW
- promote: no
