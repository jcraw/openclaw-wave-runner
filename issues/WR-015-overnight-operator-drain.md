---
id: WR-015
title: Overnight operator drain — Jason-kicked long run (not unsupervised unrestricted)
status: done
priority: high
created: 2026-08-15
updated: 2026-08-15
source: jason
agent_eligible: true
eligibility: agent_eligible
depends_on: [WR-014]
verify: npm test
labels: [overnight, drain, safety]
---

# WR-015 — Overnight operator drain

## Problem
“Overnight unrestricted” SAFETY flag blocks long unattended runs. Jason wants: before sleep, kick drain, let it run all night. That is **operator overnight**, not autonomous every-night cron + LLM.

## Goal
Clarify + enable: one explicit kick can run for hours/overnight with no wall deadline, no LLM control loop, emergency-stop still works. Keep *unprompted* autonomous overnight OFF.

## Scope
1. Rename/docs distinction:
   - `autonomousOvernight` / recurring = OFF forever unless Jason dual-keys
   - `operatorOvernightDrain` = allowed when Jason/Astra runs `drain --eligible --overnight` (or nohup drain)
2. No 30m/6h silent kill on operator overnight drain (shell wall only if explicitly set)
3. Logging + morning summary path (file, not LLM)
4. SAFETY: do not require productionDrainEnabled for operator drain
5. Runbook: “drain before sleep” recipe

## Acceptance
- [ ] Docs clear: operator overnight ≠ unrestricted autonomous
- [ ] Drain can run >30m default
- [ ] Still no recurring LLM poll
- [ ] Emergency stop works
