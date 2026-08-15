---
id: WR-005
title: Persist and inspect why a stage/ticket died
status: done
priority: high
created: 2026-08-14
updated: 2026-08-14
source: jason
agent_eligible: true
eligibility: agent_eligible
depends_on: []
verify: npm test
labels: [closer, inspect]
---

# WR-005 — Write the reason

## Problem
When RRT-005 PLAN came back cancelled, inspect showed `result: cancelled` and nothing else — no ACP summary, timeout, verify output, or operator cancel. Archaeology took a human.

`ticket.result` already exists (budget-stop uses it). It is not consistently filled from worker truth / verify proof, and `WaveView` / CLI inspect do not surface a dedicated reason.

## Scope
In:
- On settle `failed` / `cancelled`, persist a short reason on the ticket (reuse `result` or add `lastError` — one field, not both)
- Prefer worker `terminalSummary` / inspect error; then verify proof snippet; then `operator cancel` / `dependency …` from WR-004
- Include that field on inspect `WaveView` tickets **and** stages
- Tests: cancelled ACP summary round-trips; verify-fail stores command/output snippet; operator cancel reason is explicit

Out:
- Changing ACP spawn
- Retries
- Worktree chaining
- Merge / push / overnight / drain
- Pretty log UIs

## Acceptance
- [ ] `inspect` JSON shows a non-generic reason for cancel, fail, and verify-fail
- [ ] Reason is durable in the sqlite ticket/stage row (survives process restart)
- [ ] Existing compact operator output can keep using `result` if that is the field
- [ ] `npm test` green

## Owning paths
- `src/domain/types.ts`
- `src/core/settlement.ts`
- `src/core/wave-projection.ts` / inspect DTO
- `src/adapters/openclaw-acp.ts` only if summary is dropped today
- `test/`

## Agent notes
Cap stored reason (~500 chars). Do not dump full verify logs into the ledger. Public package only.

## Resolution

**Done 2026-08-14**. Reliability pass: empty worker death retries once; durable ticket.result reason; worker death -> FAILED (operator cancel stays CANCELLED). npm test 103 passed. Commit c71bee8.
