---
id: WR-012
title: Defaults for real drain — no wall, higher token ceiling, more launches/retries, longer lease
status: done
priority: high
created: 2026-08-15
updated: 2026-08-15
source: jason
agent_eligible: true
eligibility: agent_eligible
depends_on: []
verify: npm test
labels: [defaults, drain, budget, reliability]
---

# WR-012 — Defaults for real drain

## Problem
Pilot-era defaults still hamstring overnight/backlog drain: low token ceilings + indeterminate 8k reserves cause false `BUDGET_STOPPED`; short leases; weak retry; leftover 30m wall in DEFAULT_LIMITS; SAFETY caps too tight for multi-hour product IMPL.

## Goal
Orchestrator stays cheap (no LLM loop). Workers may use full budget. Defaults match “drain until done” not “30-minute pilot”.

## Scope
1. `SUPERVISED_PILOT_LIMITS` + supervised SAFETY:
   - `maxWallTimeMs: 0` (no elapsed kill)
   - never set `deadlineMs` by default on create/CLI
   - `maxTokens` raise substantially (e.g. 500_000) OR stop counting unresolved indeterminate forever
   - `maxLaunches: 10`
   - `maxRetriesPerStage: 2`
   - `perProviderConcurrency` align with ACP (at least 5)
2. `leaseTtlMs` default ≥ 2h for live runtime
3. `DEFAULT_LIMITS.maxWallTimeMs` → 0 (stop advertising 30m)
4. Docs: OPERATOR-RUNBOOK notes these are drain defaults
5. Tests updated for new caps

Out: land-on-done (WR-013), drain CLI (WR-014), overnight operator path (WR-015)

## Acceptance
- [ ] No default deadline on supervised create
- [ ] Long IMPL not killed at 30m by defaults
- [ ] Higher launch/retry/token ceilings live
- [ ] `npm test` green
