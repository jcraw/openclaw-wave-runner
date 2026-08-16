---
id: WR-019
title: P0/P1 stuck-wave recovery — release lease on IMPL fail, terminal when stuck, admit verify
status: impl
priority: high
created: 2026-08-16
updated: 2026-08-16
source: jason
agent_eligible: true
eligibility: agent_eligible
depends_on: []
verify: npm test
labels: [recovery, lease, operator, admit]
---

# WR-019 — P0/P1 stuck-wave recovery

## Problem
Supervised wave `BL-RR-070-068-20260816104319` (RR-070 + RR-068, writer scope `game:rink_rush`) wedged:

1. Tickets frozen without `verifyCommand` → IMPL settle correctly failed `missing_verify` (WR-018).
2. Worker still produced real IMPL work; ticket = **FAILED**.
3. Writer lease for `game:rink_rush` stayed held by RR-070 after that fail.
4. RR-068 sat `APPROVED` / `nextAction: launch-impl` forever.
5. Wave stayed **RUNNING**; operator looped 100+ no-op ticks.
6. Late-editing ticket frontmatter after freeze did nothing (manifest already frozen).

## Goal
Same-scope multi-ticket waves fail closed and recover. An IMPL that is no longer active never keeps a writer lease. A wave leaves `RUNNING` when nothing can run. The operator loop cannot burn ticks on a frozen fingerprint. Admit never discovers `missing_verify` after a paid IMPL launch.

Do **not** reopen WR-018: settle still fail-closes on missing verify. This ticket is recovery + admit-time enforcement + operator/runbook hygiene.

## Acceptance
- [x] IMPL fail / cancel / `missing_verify` / `stale_fence` / verify-fail releases the writer lease
- [x] WR-010 IMPL retry to `APPROVED` keeps the lease; same-scope sibling waits
- [x] `cancel` / `emergencyStop` / `stopForBudget` release inactive writer leases
- [x] Wave leaves `RUNNING` when leftover `APPROVED` is blocked only by a terminal-held lease
- [x] Live foreign lease does not instant-fail `APPROVED` this tick
- [x] Operator `STUCK_TICKS` (default 20) prints `OPERATOR_STOP stuck` and exits 1
- [x] Empty/missing `verifyCommand` fails closed at dry-run and create (`missing_verify`)
- [x] Controller flip after a succeeded worker receipt is named on `ticket.result` + `settle-reason`
- [x] Runbook kick hygiene: verify, `agent_eligible`, no stale lease, one ticket per shared scope until smoke is green
- [x] `npm test` green

## Owning paths
See plan `plans/2026-08-16-wr-019-stuck-wave-recovery.md`.

## Related
- WR-018 owns settle-time `missing_verify` (keep as belt).
- WR-010 owns IMPL retry re-arm to `APPROVED`.
- WR-011 owns path-scoped writer leases.

## Agent notes
Substantial: PLAN → Crawmak review → Astra stamp → fresh IMPL.
Verify: `npm test`. Land gate: `npm test && npm run quality`.
No deploy, push, merge, or Gateway changes in the IMPL worker turn.
