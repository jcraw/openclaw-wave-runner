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

SP2-063 Codex PLAN spawn succeeded; turn 400: `The 'gpt-5.6-sol' model requires a newer version of Codex.` That is **@zed-industries/codex-acp 0.16.0** (embedded client), not PATH `codex`. CLI 0.152.1 can run Sol via `codex exec`; ACP 0.16.0 cannot. gpt-5.5 + thinking off was a spawn workaround — **not house**. House is `gpt-5.6-sol` + thinking high via `@agentclientprotocol/codex-acp` and `scripts/codex-acp-compat.mjs` (OpenClaw concatenates `--model gpt-5.6-sol/high`; wrapper advertises it and maps thinking → `reasoning_effort`). Isolated `config.toml` Sol/high. WR-040 drain-refuse of Codex was a workaround — undone here.

## Acceptance

- [x] Drain does **not** `PREFLIGHT_FAIL` hybrid / `plan_worker: codex`.
- [x] Codex ACP spawn model is `gpt-5.6-sol` + thinking `high` unless `WAVE_CODEX_MODEL` / `WAVE_CODEX_THINKING`.
- [x] Live ACP smoke wrote PLAN.md with Sol; wrapper log had no Sol 400 and spawn was not `ACP_MODEL_UNSUPPORTED` for `gpt-5.6-sol/high`.
- [x] Failed Codex turn result includes the wrapper 400 body when logs are present.
- [x] Apply-IMPL-only and freeze `needsUx` stay (WR-040).
- [x] `npm test` green.
