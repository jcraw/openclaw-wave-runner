---
id: WR-034
title: Drop operator-overnight; one drain command; no clock-time mode
status: done
priority: high
created: 2026-08-24
updated: 2026-08-24
source: jason
assignee: crawmak
builder: crawmak
worker: grok
preferred_model: grok
agent_eligible: true
eligibility: done
needs_jason: false
phase: done
labels: [drain, safety, naming, operator]
depends_on: [WR-015, WR-033]
related: [WR-012, WR-014]
verify: npm test && npm run quality
verify_command: npm test && npm run quality
worker_out_dir: tmp/workers/WR-034
plan: plans/2026-08-24-wr-034-drop-operator-overnight.md
land: commit
---

# WR-034 — Drop operator-overnight

Jason 2026-08-24: “overnight” is leftover language from a passing comment. Waves run at any time of day. Clock time is not a gate. Stop treating overnight as an operator mode.

## Problem

Two things share a bad name:

1. **Unprompted re-drain / LLM poll** — real red line. Cron, recurring backlog poll, drain-everything without a kick. Stays off.
2. **`OVERNIGHT=1`** — only lifts the **6h shell wall** in `scripts/run-backlog-wave.sh` (`WALL_S` default 21600). Controller wall is already `MAX_WALL_MS=0`. Drain scripts never pass TypeScript `operatorOvernight`. Kick receipts (`overnight OFF, apply, no push`) make a timeout look like a first-class time-of-day mode.

## Goal

One kick command. Drain runs until the queue is empty or a real stop (stage watchdog, token/launch caps, stuck, human hold, emergency-stop). Optional `WAVE_WALL_S` is a timeout, not sunset. Operator-facing copy does not say overnight. Safety pins stay off.

## Acceptance

- [x] `run-backlog-wave.sh` default `WAVE_WALL_S=0` (no 6h silent kill)
- [x] `OVERNIGHT` is not required; if set, one-release alias for `WAVE_WALL_S=0` when unset, plus a deprecation note
- [x] Drain start banner does not print `OVERNIGHT=`; receipts/logs do not advertise overnight as a mode
- [x] Dead `operatorOvernight` / `operatorOvernightDrainAllowed` removed; `overnight: true` still throws
- [x] Frozen manifest still pins `overnight: false` (no schema bump)
- [x] Projection / capabilities still expose `overnightEnabled: false` (CrawDash compat)
- [x] Runbook/README/SECURITY/CONTRIBUTING: unprompted re-drain / LLM poll stay off; one drain command; no daytime vs overnight split
- [x] Historical tickets/plans (WR-015 etc.) not rewritten
- [x] `npm test && npm run quality`. Commit-land WR `main` + push origin

## Non-goals

Flipping `SAFETY.*` on. Cron. LLM control loops. Manifest schema 2. Crawmak `AGENTS.md`, jam `ORCHESTRATION.md`, Astra `CONTROL_PLANE.md`, CrawDash field rename (sibling/follow-up copy).
