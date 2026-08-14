---
id: WR-004
title: Fail the wave when a mid-chain ticket dies
status: open
priority: high
created: 2026-08-14
updated: 2026-08-14
source: jason
agent_eligible: true
eligibility: agent_eligible
depends_on: []
verify: npm test
labels: [closer, state-machine]
---

# WR-004 — Fail the wave when the middle dies

## Problem
`maybeCompleteWave` only fires when **every** ticket is already terminal. A `CANCELLED`/`FAILED` middle ticket leaves dependents `PENDING`, so the wave stays `RUNNING` and the operator loop ticks forever. Seen on `RRT-FP-20260814091123`: RRT-004 DONE, RRT-005 PLAN cancelled, RRT-006 pending.

Operator wave-cancel (all tickets cancelled) must stay `CANCELLED`, not this path.

## Scope
In:
- After a selected ticket becomes `FAILED` or `CANCELLED`, fail remaining in-wave tickets that depend on it (direct or transitive) with a short result string (`dependency WR-00X cancelled` / `failed`)
- Then `maybeCompleteWave` must reach `FAILED` (or `CANCELLED` only if **every** ticket is `CANCELLED`)
- No new launches for those dependents
- Tests: 3-ticket chain, middle cancel → dependents failed, wave `FAILED`, loop would stop
- Tests: operator cancel-all still `CANCELLED`

Out:
- ACP retries
- Worktree chaining (WR-006)
- Merge / push / overnight / drain
- New ticket statuses

## Acceptance
- [ ] Mid-chain `CANCELLED` or `FAILED` does not leave dependents `PENDING`
- [ ] Wave becomes `FAILED` (not stuck `RUNNING`)
- [ ] Operator cancel-all remains `CANCELLED`
- [ ] `npm test` green

## Owning paths
- `src/core/tick.ts` (`maybeCompleteWave`, `nextEligibleTicket`, settle follow-up)
- `src/core/settlement.ts`
- `src/core/state-machine.ts` only if a transition is missing
- `test/phase1-core.test.ts` (or equivalent)

## Agent notes
Keep it dumb. Do not invent BLOCKED-for-deps unless a test already requires it. Public package only.
