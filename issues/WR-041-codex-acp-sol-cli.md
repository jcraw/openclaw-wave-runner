---
id: WR-041
title: Codex ACP PLAN must run Sol — upgrade CLI, do not skip hybrid
status: done
priority: crit
created: 2026-09-01
updated: 2026-09-01
source: jason
assignee: crawmak
builder: crawmak
worker: grok
preferred_model: grok
agent_eligible: true
eligibility: agent_eligible
needs_jason: false
phase: impl
labels: [p0, hybrid, acp, codex]
depends_on: [WR-035, WR-040]
related: [WR-039]
verify: npm test
verify_command: npm test
land: commit
plan_review: skip
---

# WR-041 — Codex ACP Sol CLI

SP2-063 Codex PLAN spawn succeeded; turn 400: `The 'gpt-5.6-sol' model requires a newer version of Codex.` CLI was 0.147.0; 0.152+ required. OpenClaw mapped that to `ACP_TURN_FAILED: Internal error`. WR-040 drain-refuse of Codex was a workaround — undone here.

## Acceptance

- [x] Host Codex on the acpx PATH is ≥ 0.152 (`~/.local/bin/codex` → nvm 24.18.1; wrapper prepends that bin).
- [x] Drain does **not** `PREFLIGHT_FAIL` hybrid / `plan_worker: codex`.
- [x] Failed Codex turn result includes the wrapper 400 body when logs are present.
- [x] Apply-IMPL-only and freeze `needsUx` stay (WR-040).
- [x] `npm test` green.
