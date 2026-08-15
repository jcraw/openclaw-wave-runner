---
id: WR-014
title: Operator drain --eligible — low-token backlog runner until empty
status: done
priority: high
created: 2026-08-15
updated: 2026-08-15
source: jason
agent_eligible: true
eligibility: agent_eligible
depends_on: [WR-012, WR-013]
verify: npm test
labels: [drain, operator, parallel, orchestration]
---

# WR-014 — drain --eligible

## Problem
“Run the backlog” requires hand-built ticket lists and ad-hoc scripts. Old LLM drain spent orchestration tokens. Need deterministic operator drain.

## Goal
One command freezes agent_eligible open tickets, lanes by writer scope, runs supervised waves in parallel across scopes / serial within scope, lands each (WR-013), loops until empty or human hold.

## Scope
1. CLI/script: `wave-operator drain --eligible` (or `scripts/drain-eligible.sh`)
2. Select tickets: open + agent_eligible + deps satisfied (done/external)
3. Lane by board/writer scope; MAX_PARALLEL default 5 (match ACP)
4. Per ticket: create→start→tick loop with auto plan-gate; no LLM orchestrator
5. Skip/stop on WAITING_APPROVAL (human); continue other lanes
6. Summary JSONL of outcomes
7. **Zero model calls in the drain controller itself**

Out: cron auto-start without Jason; LLM polling

## Acceptance
- [ ] Explicit operator kick drains eligible set
- [ ] Parallel across products, serial within
- [ ] No LLM calls in drain loop code path
- [ ] Docs in OPERATOR-RUNBOOK
