---
id: WR-042
title: Live run — enqueue slices + global ACP slots
status: in_progress
priority: crit
created: 2026-09-02
updated: 2026-09-02
source: jason
assignee: crawmak
builder: crawmak
worker: grok
preferred_model: grok
agent_eligible: true
eligibility: agent_eligible
needs_jason: false
phase: impl
labels: [p0, supervisor, enqueue, acp, orchestration]
depends_on: [WR-026, WR-039]
related: [WR-043, WR-044, WR-045]
verify: npm test && npm run quality
verify_command: npm test && npm run quality
land: commit
plan: plans/2026-09-02-wr-042-live-run-enqueue.md
---

# WR-042 — Live run, enqueue, global ACP slot

Kicking a second `run-backlog-wave.sh` must **join** the live operator, not spawn a rival ACP pool. Freeze stays immutable (a slice). The run is the merge.

## Acceptance

- [ ] Second kick on a live supervisor: new frozen slice, **same supervisor pid**, no second nohup tick loop.
- [ ] ACP occupancy is counted across slices (and across ledgers under `WR_SCRATCH/ledgers`), cap default 4.
- [ ] Same-scope IMPL still exclusive (WR-026). Disjoint scopes may IMPL if ACP slots remain.
- [ ] `wave-cli enqueue` / `tick-all` exist. `WAVE_JOIN_SUPERVISOR=0` keeps the old solo tick loop.
- [ ] `npm test` includes `test/wr-042-enqueue-supervisor.test.ts`.
- [ ] No PLAN/IMPL token ceiling added.

## Non-goals

- Continue-from-plan (WR-043)
- ACP_TURN_FAILED no-retry (WR-044)
- Per-ticket cancel (WR-045)
- Mutating a frozen manifest
