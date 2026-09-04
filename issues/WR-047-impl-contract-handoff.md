---
id: WR-047
title: Freeze Crawmak AWC conditions as IMPL_CONTRACT.md
status: done
priority: high
created: 2026-09-03
updated: 2026-09-03
phase: done
source: jason
assignee: crawmak
builder: crawmak
worker: grok
preferred_model: grok
agent_eligible: true
eligibility: agent_eligible
needs_jason: false
labels: [plan-gate, review, handoff, tokens]
depends_on: [WR-028, WR-033, WR-038]
related: [WR-009, WR-023, CA-016]
verify: npm test && npm run quality
verify_command: npm test && npm run quality
land: commit
plan: plans/2026-09-03-wr-047-impl-contract-handoff.md
---

# WR-047 — IMPL reads frozen Crawmak conditions

WR-033 made Crawmak Verdict the plan gate. `approve-with-conditions` never reaches the IMPL worker: spawn prompt is `IMPL <id> <title>` plus a copy of `PLAN.md`. Review cwd is the forge; IMPL cwd is the worktree. Conditions stay in `crawmak/reviews/<ID>.md`. IMPL re-scouts the repo (100k–300k context) or misses the bites.

Jason 2026-09-03: do not cap Grok (SuperGrok week is the budget). Keep Crawmak review. Do not mutate `PLAN.md` from review (WR-038 class). Do not add hops. Guardrail harness changes with no-Grok tests so this does not take a week to unbreak.

## Acceptance

- [x] Pure `extractImplContract(reviewText)` in a **new** `src/core/` file (do not grow `settlement.ts`). Heading `## Conditions or revise`. Cap 8000 chars — over cap is fail, not clip.
- [x] `approve-with-conditions` + empty/missing/“none” body → **do not** `APPROVED`. Ticket stays `PLAN_REVIEW` with `missing_impl_contract`. REVIEW hop is not re-launched. Fix the review file; next tick admits.
- [x] `approve` / `plan_review: skip` / leftover stamp-without-Crawmak-launch: no contract required.
- [x] On IMPL launch, freeze extract bytes to `<outputDir>/IMPL_CONTRACT.md` (same copy pattern as `APPROVED_PLAN.md`). Spawn **task** names that file; does not inline Findings / Cheat-mode / Learn.
- [x] `PLAN.md` bytes at `planArtifact` unchanged after review admit (test hash).
- [x] Simulator tests (WR-028 style) + table tests + `scripts/probe-impl-handoff.ts` (`npm run probe:handoff`) with zero xAI. Probe exit 1 on fail-closed.
- [x] `docs/OPERATOR-RUNBOOK.md` plan-gate section patched (live). `npm test && npm run quality`. Commit-land + push origin.

## Non-goals

Grok concurrency caps. Mutating PLAN from review. `LEARNED.md` / summarizer hop. Default impl-review. Mona UX contract fold. `checkPlanArtifact` requiring `## Read first` (in-flight salvage). Live ACP smoke as CI. SuperGrok / ACP usage DTO (WR-009). Forge templates (CA-016). Changing hop counts or WR-038 hop-ready rules.
