---
id: WR-046
title: Supervisor run health, lease adoption, fail-loud ticks
status: done
priority: crit
created: 2026-09-03
updated: 2026-09-03
phase: done
source: jason
assignee: crawmak
builder: crawmak
worker: grok
preferred_model: grok
agent_eligible: true
eligibility: agent_eligible
needs_jason: false
labels: [p0, supervisor, lease, closeout, orchestration]
depends_on: [WR-042, WR-026, WR-032]
related: [WR-043, WR-044, WR-045]
verify: npm test && npm run quality
verify_command: npm test && npm run quality
land: commit
plan: plans/2026-09-03-wr-046-supervisor-run-health.md
---

# WR-046 — Supervisor run health + lease adoption

WR-042 made one supervisor the ticker, then left it as a weaker operator: no safe identity, no heartbeat, swallowed `tick-all` failures, join-mode inspect-only, and a different `processIdentity` than the process that acquired the writer lease. Overnight 2026-09-02/03 the supervisor looped SafetyGate for hours; workers then succeeded and closeout failed `stale_fence: writer lease missing`.

## Acceptance

- [x] Supervisor boot sets a safe `WAVE_RUNNER_OPERATOR_ID` (never inherit a path). Unsafe/empty → exit 1, no pidfile loop.
- [x] `peek_repo` opens the sqlite path (`argv[2]` or a `wave-cli` helper). No `unable to open database file` on `-`.
- [x] `$WR_SCRATCH/supervisor.heartbeat` written every loop. `supervisor_alive` is pid **and** heartbeat younger than `3 * TICK_SLEEP`. Stale → treat dead.
- [x] Five consecutive `tick-all` failures exit the supervisor, remove pidfile (`OPERATOR_STOP repeated_tick_fail`). Frozen `RUNNING` + no live outbox uses existing `STUCK_TICKS`.
- [x] JOIN=1: create + start + print status + exit 0. No inspect spectator. `WAVE_JOIN_SUPERVISOR=0` stays the solo ticker.
- [x] Join-mode create/start/tick-all share one run identity. IMPL-active writer leases are adopted (pid rewritten, TTL refreshed), not deleted because the create/start pid died.
- [x] Supervisor spawn exports `WAVE_LAND_MODE` (jam drain default `apply`). Create freezes `landMode` onto the ticket when YAML omitted so tick-all does not depend on later env.
- [x] `land-retry` re-acquires the writer lease as the current ticker, then closeout. Worker-succeeded + dead operator pid + supervisor tick → DONE, not `stale_fence`.
- [x] `countOpenProvider` ignores outbox on terminal waves.
- [x] `wave-cli status` prints pid, heartbeat age, per-ticket stage/status, last tick error.
- [x] Tests exec `wave-supervisor.sh` (missing identity exits; 5 tick fails exit; heartbeat stale ⇒ not alive). Plus lease-adoption and land-retry fixtures.
- [x] `npm test && npm run quality`

## Non-goals

- WR-043 continue-from-last-good-stage (already filed)
- WR-044 host-fail no PLAN retry
- WR-045 per-ticket cancel
- OpenClaw xAI/GPT OAuth refresh / agentTurn crons (not WR)
- LLM health poller
