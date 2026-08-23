---
id: WR-031
title: Long ACP jobs — do not send sessions_spawn timeoutSeconds; host walls own OpenClaw
status: done
priority: crit
created: 2026-08-22
updated: 2026-08-22
source: jason
assignee: crawmak
builder: crawmak
worker: grok
preferred_model: grok
agent_eligible: true
eligibility: agent_eligible
needs_jason: false
phase: done
labels: [p0, acp, timeout, closeout]
depends_on: [WR-029]
related: [WR-027, WR-030]
verify: npm test && npm run quality
verify_command: npm test && npm run quality
worker_out_dir: tmp/workers/WR-031
plan: ""
land: commit
---

# WR-031 — Long ACP jobs

OpenClaw `sessions_spawn` **does not accept per-call timeout overrides**. WR-029 sending `timeoutSeconds` made spawn fail. Host `agents.defaults.timeoutSeconds=3600` is the 1h ACP kill (MUD-040 / WR-027). Subagent run timeout is `agents.defaults.subagents.runTimeoutSeconds` (`0` = none).

## Acceptance

- [x] `sessions_spawn` args never include `timeoutSeconds` (even if WR has a stage wall).
- [x] WR wall stays `WAVE_PLAN_WALL_MS` / `WAVE_IMPL_WALL_MS` (`0` = watchdog off).
- [x] Runbook names the two OpenClaw keys. Overnight drain stays off.
- [x] `npm test && npm run quality`; commit-land + push.

Also: commit `scripts/cleanup-scratch.sh` with `ledgers` protected. Drop accidental WR-028 `worker_pid` line.
