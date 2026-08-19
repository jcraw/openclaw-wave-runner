---
id: WR-023
title: Deterministic agent plan-gate — no Astra in the drain loop
status: done
priority: crit
created: 2026-08-19
updated: 2026-08-19
source: jason
assignee: crawmak
builder: crawmak
worker: grok
preferred_model: grok
agent_eligible: true
eligibility: agent_eligible
needs_jason: false
phase: done
labels: [p0, plan-gate, operator, drain, anti-llm-orchestrator]
depends_on: []
related: [WR-008, WR-014, WR-022]
verify: npm test && npm run quality
verify_command: npm test && npm run quality
worker_out_dir: tmp/workers/WR-023
plan: plans/2026-08-19-wr-023-deterministic-plan-gate.md
land: commit
---

# WR-023 — Agent PLAN continues without Astra

Jason (2026-08-19): drain must be tooling. Kick a wave, tickets complete. Do not spend orchestration tokens waiting for Astra to notice a plan-review. LLM workers (PLAN/IMPL) stay. LLM control loop after PLAN does not.

## Problem

WR-008 split agent-gate from Jason hold, then waited for Astra to read the plan. Production never wired `WakePort`. Drain “fixed” it by bash-stamping `APPROVED by Astra` (`AUTO_PLAN_GATE`). Honest Crawmak review is a sidecar; the wake CLI is wrong; Astra asks Jason. Waves die at `plan_review`.

`needs_jason: pick` (a post-IMPL board note) is treated as a human hold.

## Goals

1. Agent tickets: PLAN artifact check (script) → ledger `APPROVED` → IMPL. No Astra, no invented stamp, no sleep-wait.
2. `needs_jason` hold only for boolean true / `human_gated`. Annotations (`pick`, `opinion`) are not holds.
3. Drain selector skips real holds. Operator does not bash-stamp Astra.
4. `npm test && npm run quality` green; land commit + push origin.

## Non-goals

- WR-022 apply-closeout (jam dirty desk). Separate ticket.
- Wiring `WakePort` to OpenClaw.
- Crawmak review as a WR stage.
- SAFETY / overnight / unrestricted drain flips.
