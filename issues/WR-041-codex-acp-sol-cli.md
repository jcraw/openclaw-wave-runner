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

SP2-063 Codex PLAN spawn succeeded; turn 400: `The 'gpt-5.6-sol' model requires a newer version of Codex.` That is **@zed-industries/codex-acp 0.16.0** (embedded client), not PATH `codex`. CLI 0.152.1 can run Sol via `codex exec`; ACP 0.16.0 cannot. WR spawn pins **gpt-5.5** (adapter-known) + thinking off. Still Codex ACP PLAN, not Grok. Isolated `config.toml` Sol is overridden by spawn args. WR-040 drain-refuse of Codex was a workaround — undone here.

## Acceptance

- [x] Drain does **not** `PREFLIGHT_FAIL` hybrid / `plan_worker: codex`.
- [x] Codex ACP spawn model is `gpt-5.5` unless `WAVE_CODEX_MODEL` (Sol is rewritten; it 400s on 0.16.0).
- [x] Live ACP smoke wrote PLAN.md; wrapper log had no Sol 400.
- [x] Failed Codex turn result includes the wrapper 400 body when logs are present.
- [x] Apply-IMPL-only and freeze `needsUx` stay (WR-040).
- [x] `npm test` green.
