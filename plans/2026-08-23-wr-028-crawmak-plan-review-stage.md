# WR-028 plan — Crawmak review as a WR stage

**Ticket:** `issues/WR-028-crawmak-plan-review-stage.md`
**Verify:** `npm test && npm run quality`
**Land:** commit + push origin
**Author:** `JCraw <4335668+jcraw@users.noreply.github.com>`

APPROVED by Jason

## 1. Goal

Default agent-eligible tickets: **PLAN → Crawmak forge-cwd review → stamp on the plan file → ledger APPROVED → fresh IMPL**. WR-023 skip-bit auto-IMPL stays. No Astra LLM orchestrator, no bash-stamp, no `kick.sh --phase plan`, no WakePort.

## 2. Decisions

| # | Pick |
|---|---|
| D1 | Skip review **only** via freeze-time YAML: `plan_review: skip` \| `review: skip` \| `review_skip: true` \| `jason_skip: true`. Pure `resolvePlanReviewSkip`. Do **not** infer from verify=`true`, plan length, or `planClass`. |
| D2 | Skip path = WR-023 unchanged: `APPROVED` + `plan_gate_auto`, wave `RUNNING`, IMPL next tick. |
| D3 | Default (no skip, no human hold): keep ticket `PLAN_REVIEW`, wave `AWAITING_PLAN_GATE`, launch **one** `REVIEW` stage. No `plan_gate_auto`. No IMPL. |
| D4 | Human hold first: `WAITING_APPROVAL` / `OPERATOR_STOP waiting_human`. No review launch. `needs_jason: pick` is not a hold. |
| D5 | `StageName += "REVIEW"`. `queueStage("REVIEW")` does not change ticket status (stay `PLAN_REVIEW`) and does not take a writer lease. |
| D6 | REVIEW cwd = forge: `CRAWMAK_FORGE` else sibling `../crawmak` with `AGENTS.md`. Missing forge → stay `PLAN_REVIEW` (`missing_forge`). Artifact = `{forge}/reviews/{TICKET}.md`. Never `kick.sh`. |
| D7 | Pass artifact is the **forge review file**, not worker success. `checkPlanReview`: exists + `Verdict: approve\|approve-with-conditions\|revise` + `## Cheat-mode scan` + `## Learn`. Else theater → stay `PLAN_REVIEW`. |
| D8 | `revise` → existing `reviseWave`. Cap **1** unless ticket `plan_review_revise_cap`. Second revise → `FAILED` `plan_review_revise_cap`. Never IMPL on revise. |
| D9 | `approve` / `approve-with-conditions` do **not** ledger-approve. Wait for `APPROVED by Astra` or `APPROVED by Jason` on the **plan file**. Then APPROVED + wave RUNNING + IMPL. |
| D10 | Leftover: stamp on plan **and** no `plan_review_launch` for this ticket/revision → may ledger-approve. If a review was launched this hop, review pass is required. |
| D11 | `AUTO_PLAN_GATE=1` must not bash-stamp and must not `approve` just because the wave is gated. Operator **ticks** during `AWAITING_PLAN_GATE` so REVIEW can launch; `maybeAdmitPlanGate` admits on stamp. |
| D12 | `policy.decide` auto-approve is **not** a review skip. |
| D13 | Sim FX-* fixtures set `planReviewSkip: true` so the existing suite stays the skip-bit path. |

## 3. Tests

See `test/wr-028-plan-review.test.ts`. Keep `test/wr-023-plan-gate.test.ts` as the skip-bit path.

## Learn

- bite: none
- candidate: agent PLAN auto-IMPL → Crawmak review stage + stamp; skip only via `plan_review: skip`
- promote: no
