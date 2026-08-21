---
id: WR-027
title: Supervised live pipeline proof on post-026 main
status: open
priority: high
created: 2026-08-20
updated: 2026-08-20
source: jason
assignee: crawmak
builder: crawmak
worker: grok
preferred_model: grok
agent_eligible: true
eligibility: agent_eligible
needs_jason: false
phase: impl
labels: [smoke, pipeline, supervised]
depends_on: [WR-026]
related: [WR-023, WR-025, WR-026]
verify: test -s docs/operator-receipts/2026-08-20-supervised-smoke.md
verify_command: test -s docs/operator-receipts/2026-08-20-supervised-smoke.md
worker_out_dir: tmp/workers/WR-027
land: commit
---

# WR-027 — Supervised live pipeline proof

Prove one supervised CLI wave on current `main` (post-WR-026 shared ledger) can run PLAN → auto-approve → IMPL → verify → commit-land → DONE.

## Work

Write `docs/operator-receipts/2026-08-20-supervised-smoke.md` with:

- UTC timestamp
- `git rev-parse HEAD` at impl time
- `WAVE_ID` if present in the environment, else `unspecified`
- one line: `supervised live pipeline completed on post-WR-026 main`

Create the directory if missing. Do not edit any other path.

## Acceptance

- [ ] Receipt file exists and is non-empty
- [ ] Ticket verify `test -s docs/operator-receipts/2026-08-20-supervised-smoke.md` exits 0
- [ ] Commit-lands (`land: commit`) and pushes `origin` when `WAVE_LAND_PUSH=1`

## Non-goals

- ACP 1h / CLI-worker fallback (follow-up)
- SAFETY flips, overnight drain, `scripts/cleanup-scratch.sh`
- `npm test` / quality as this ticket's verify (receipt existence only)
