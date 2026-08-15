---
id: WR-010
title: Retry once on empty worker death (make maxRetries real)
status: open
priority: high
created: 2026-08-14
updated: 2026-08-14
source: jason
agent_eligible: true
eligibility: agent_eligible
depends_on: []
verify: npm test
labels: [closer, retry, acp, reliability]
---

# WR-010 — Retry once on empty worker death

## Problem
RRT-009 PLAN: Grok ACP session closed ~5m with **no** `PLAN.md` / `terminal.json`. Wave Runner settled **CANCELLED**, `maxRetriesPerStage: 0`, chain hard-stopped.

`maxRetriesPerStage` is checked in `queueStage` admission but **settle always terminals** the ticket on fail/cancel. Retries never re-queue. So the knob is dead.

Operator cancel (`cancelRequested`) must still terminal-cancel with no retry.

## Goal
One cheap automatic retry on flaky empty worker death. Prefer completing over archaeology. Do **not** burn multi-retry loops.

## Scope
In:
1. **Default** `maxRetriesPerStage: 1` in `DEFAULT_LIMITS` + `SUPERVISED_PILOT_LIMITS` (was 0).
2. On stage settle `failed` / `cancelled` when **not** `wave.cancelRequested`:
   - Persist a short `ticket.result` reason (share field with WR-005 if both land; cap ~500 chars). Prefer inspect `error`/`summary`, else `empty stage artifacts` / `worker cancelled` / `worker failed`.
   - If `attempt - 1 < maxRetriesPerStage` (retries remain):
     - Mark stage terminal FAILED/CANCELLED as today for that attempt.
     - **Do not** terminal the ticket. Re-arm for same stage:
       - PLAN → ticket `REVISING` (or equivalent already used for re-plan) so `advanceReadyTickets` queues PLAN again
       - IMPL → ticket `APPROVED` so IMPL queues again
     - Wave stays `RUNNING` (not FAILED/CANCELLED from this ticket alone).
   - If no retries left → ticket `FAILED` (worker death is **FAILED**, not operator `CANCELLED`).
3. Operator / wave cancel path unchanged: tickets `CANCELLED`, no retry.
4. Tests:
   - PLAN empty-cancel with maxRetries=1 → second PLAN attempt queues; first stage CANCELLED/FAILED; ticket not terminal after first
   - Second empty-cancel → ticket FAILED, wave can complete FAILED
   - `cancelRequested` → CANCELLED, no second attempt
   - maxRetries=0 still terminals on first death (compat)

Out:
- Multi-ticket worktree chaining (WR-006)
- Agent vs human plan-gate split (WR-008)
- Usage estimate plumbing (WR-009)
- Raising retries above 1 by default
- Overnight / drain / merge / push product waves
- Changing ACP spawn transport

## Acceptance
- [ ] Empty ACP cancel no longer one-shots a supervised ticket when `maxRetriesPerStage >= 1`
- [ ] Default limits use `maxRetriesPerStage: 1`
- [ ] Operator cancel still `CANCELLED` with zero retry
- [ ] Exhausted retries → ticket `FAILED` with non-generic `result`
- [ ] `npm test` green

## Owning paths
- `src/domain/types.ts` (defaults)
- `src/core/settlement.ts` (retry re-arm vs terminal)
- `src/core/tick.ts` only if advance path needs a nudge
- `src/core/admission.ts` only if attempt counting needs a comment/guard
- `test/`

## Agent notes
Keep it dumb. One retry is enough. Do not add backoff timers, new statuses, or LLM classification of errors. Public package only. Push origin after land (Jason standing rule).
