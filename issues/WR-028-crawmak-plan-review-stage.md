---
id: WR-028
title: Crawmak plan-review stage — PLAN then review/revise then stamp then IMPL
status: open
priority: crit
created: 2026-08-21
updated: 2026-08-21
source: jason
assignee: crawmak
builder: crawmak
worker: grok
preferred_model: grok
agent_eligible: true
eligibility: agent_eligible
needs_jason: false
phase: plan
labels: [p0, plan-gate, review, crawmak, forge]
depends_on: [WR-023]
related: [WR-008, WR-023, WR-027, CA-008]
verify: npm test && npm run quality
verify_command: npm test && npm run quality
worker_out_dir: tmp/workers/WR-028
plan: ""
land: commit
---

# WR-028 — Restore Crawmak review in the supervised loop

Jason 2026-08-21: substantial tickets must be **PLAN → Crawmak review/updates → stamp → IMPL**. WR-023 auto-IMPL after a plan artifact is the wrong default. WR-027 live smoke proved it: `plan_gate_auto` then IMPL, no `reviews/<ID>.md`, no stamp.

Do **not** bring back Astra as an LLM orchestrator, bash-stamping `APPROVED by Astra`, or a poll loop. Drain stays tooling. Crawmak review is a **stage**. Crawmak still stamps neither.

## Problem

WR-023 D1: agent PLAN artifact check → ledger `APPROVED` → IMPL. Event `plan_gate_auto`. Wave stays `RUNNING`. Non-goal was “Crawmak review as a WR stage.”

Forge law (`crawmak/AGENTS.md` + `playbooks/plan-review.md`):

```
PLAN (fresh, stop)
  → Crawmak forge-cwd review → reviews/<ID>.md (verdict required)
  → revise? one plan-only update, review again
  → Astra or Jason stamps the plan
  → IMPL (fresh session, approved plan path)
```

Skip review only for tiny/meta/one-file, or Jason says skip. Reviews are forge-cwd ACP only. Never `kick.sh --phase plan` a review.

Human hold (`needs_jason: true` / `eligibility: human_gated`) is unchanged: `WAITING_APPROVAL`, `OPERATOR_STOP waiting_human`. `needs_jason: pick` is still not a hold.

## Goals

1. **Default for agent-eligible substantial tickets:** after PLAN, do not IMPL. Ticket `PLAN_REVIEW`, wave `AWAITING_PLAN_GATE` (reuse WR-008). Launch **one** Crawmak review worker with `--cwd` = crawmak forge (profile + `reviews/` load). Artifact is `crawmak/reviews/<TICKET>.md` with a **Verdict**.
2. **Skip review (WR-023 auto path kept) only when** frontmatter says so: `plan_review: skip` (aliases `review: skip`, `review_skip: true`) **or** Jason skip on the ticket. Tiny/meta/one-file must set that skip bit — do not infer skip from verify-command heuristics.
3. **Verdict `revise`:** re-queue PLAN once (existing REVISING path), then review again. Cap: one revise unless the ticket says otherwise. Do not IMPL on a revise verdict.
4. **Verdict `approve` / `approve-with-conditions`:** do **not** ledger-approve yet. Wait for a real stamp on the **plan file**: `APPROVED by Astra` or `APPROVED by Jason`. Then ledger-approve and IMPL (fresh session). Copying conditions onto the plan is the stamp owner’s job, not WR inventing Astra.
5. **No stamp, no IMPL.** Missing review file, missing Verdict, or review-theater (no cheat-mode scan / Learn) is not a pass. Fail-closed, keep `PLAN_REVIEW`.
6. **Launch path:** forge-cwd Grok ACP. Not `kick.sh --phase plan`. Not product-repo cwd. Forge path from registry `crawmak` or `CRAWMAK_FORGE`. Brief names ticket id, plan path, target repo, verify command (`playbooks/plan-review.md`).
7. **`AUTO_PLAN_GATE=1`** must not bash-stamp Astra and must not skip Crawmak review for non-skip tickets. Leftover `AWAITING_PLAN_GATE` with a stamp already on the plan may ledger-approve.
8. `npm test && npm run quality` green; land commit + push origin.

## Tests (named contracts, do not skip)

- Skip-bit ticket: PLAN artifact → `plan_gate_auto` → IMPL (WR-023 still true).
- Default agent ticket, no skip: PLAN → `PLAN_REVIEW` + `AWAITING_PLAN_GATE` + review launch; **no** IMPL; **no** `plan_gate_auto`.
- Review `revise` → PLAN re-queued; not IMPL.
- Review `approve` without plan stamp → still `PLAN_REVIEW`; IMPL not admitted.
- Review `approve` + `APPROVED by Astra` (or Jason) on plan → ledger approve → IMPL.
- Human hold still `WAITING_APPROVAL` / operator stop; annotations (`pick`) are not holds.
- Review launch cwd is the forge, not the product worktree.

## Non-goals

- GH_TOKEN `git push` 403 (WR-027 CLOSEOUT_DEBT; known `env -u GH_TOKEN`). Separate follow-up.
- ACP 3600s / CLI-worker fallback for long IMPL. Separate.
- SAFETY / overnight / unrestricted drain flips.
- Crawmak stamping. Inventing `APPROVED by Astra`.
- Impl review as default (`playbooks/impl-review.md` stays optional).
- Wiring OpenClaw `WakePort` as the review worker.
- Changing jam apply-closeout policy.

## Operator notes

Until this lands, **do not** `drain-eligible` / `run-backlog-wave.sh` this ticket (WR-023 would auto-IMPL it). Crawmak `kick.sh --phase plan` only.

## Learn (ticket intent)

- bite: none
- candidate: agent PLAN auto-IMPL → Crawmak review stage + stamp; skip only via `plan_review: skip`
- promote: no
