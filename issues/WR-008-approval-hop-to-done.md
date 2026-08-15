---
id: WR-008
title: Split agent plan-gate from human WAITING_APPROVAL
status: done
priority: high
created: 2026-08-14
updated: 2026-08-15
source: jason
agent_eligible: true
eligibility: agent_eligible
depends_on: []
verify: npm test
worker: grok
phase: done
worker_out_dir: tmp/workers/WR-008
worker_pid: ""
plan: plans/2026-08-14-wr-008-agent-plan-gate.md
labels: [operator, approval, closer, state-machine]
---

# WR-008 — Agent gate ≠ human hold

## Problem
`WAITING_APPROVAL` is one wave status for two different things:

1. **Human hold** (Jason / `needs_jason` / `human_gated`) — park. Doorbell optional. Do **not** auto-continue.
2. **Agent plan-gate** (Grok planned → Astra common-sense approve → impl) — next hop. Event-driven. Must not require Jason.

Today the operator loop treats both as (1). Ticket already has `PLAN_REVIEW` (owner `operator`); the wave then collapses that into `WAITING_APPROVAL` and `wave-operator.sh` **exits**. The event exists; the listener does not. MUD-Q4-036-038 sat twice.

Jason 2026-08-14: this is not waiting human approval. State machine is wrong for the agent hop.

## Design
Split the waits. Names can move; the contract cannot:

| State | Who | Operator loop |
|---|---|---|
| `AWAITING_PLAN_GATE` (or keep ticket `PLAN_REVIEW` and **do not** promote wave to `WAITING_APPROVAL`) | Astra | emit one-shot wake; stay RUNNING / non-terminal; resume after `approve`/`revise` |
| `WAITING_APPROVAL` | Jason | `OPERATOR_STOP waiting_human` — current stop behavior, correct |

Do **not** bash-stamp `APPROVED`. Astra still reads the plan.

## Scope
In:
- Wave status (or ticket+owner) distinguishes agent-gate vs human-hold
- Agent-gate: durable one-shot Astra wake (systemEvent / cron `at` now) with wave, ticket, plan path, revision
- Human-hold: still a stop
- Tests: agent-gate without wake = fail; human-hold without wake = pass; fixture `approve()` is not a substitute for the wake receipt
- `wave-operator.sh` must not `exit 0` on agent-gate

Out:
- Recurring LLM poll / re-drain
- Overnight / merge / push
- Auto-approve without reading the plan
- ACP spawn changes

## Acceptance
- [x] Default plan-ready is agent-gate, not human-hold
- [x] Kicked wave PLAN → Astra → IMPL without Jason asking (MUD-036 case)
- [x] Next ticket in the same wave gets the same hop (MUD-038 case)
- [x] `needs_jason` / `human_gated` still become `WAITING_APPROVAL` and stop
- [x] Tests fail if agent-gate has no wake receipt

## Plan

Plan ready for Astra common-sense review. Impl = fresh session.

- `plans/2026-08-14-wr-008-agent-plan-gate.md`
- `tmp/workers/WR-008/PLAN.md`

## Closeout

System fix 2026-08-15: supervised launch restored + WR-008 AWAITING_PLAN_GATE shipped. npm test 110/110. Commit 6e64c2c.
