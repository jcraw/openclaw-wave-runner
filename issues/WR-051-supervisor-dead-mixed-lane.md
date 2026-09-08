---
id: WR-051
title: Dead supervisor leaves RUNNING waves; mixed-lane Codex PLAN poisons Grok ticks; ACP agent grok missing
status: done
priority: crit
created: 2026-09-07
updated: 2026-09-07
phase: done
source: jason
assignee: crawmak
builder: crawmak
worker: grok
preferred_model: grok
agent_eligible: true
eligibility: agent_eligible
needs_jason: false
labels: [p0, supervisor, acp, grok, isolation]
depends_on: []
related: [WR-046, WR-044, WR-035, WR-028]
verify: npm test && npm run quality
verify_command: npm test && npm run quality
land: commit
plan: plans/2026-09-07-wr-051-supervisor-dead-mixed-lane.md
---

# WR-051 — Supervisor death + mixed-lane poison + unknown ACP `grok`

Status: APPROVED by Astra 2026-09-07 23:49 MST

Jason 2026-09-07 ~23:38 MST: Crawmak investigate why `wave-rrt-bugs-sequential-202609072022` (RRT-136/137/138) sat RUNNING for hours with no operator, then **fix it for the future**.

This is a **WR-046 regression / hole**, not a one-off ops miss. Astra DIY-revived a targeted supervisor; that is not the durable fix.

## Incident (live facts)

Wave `wave-rrt-bugs-sequential-202609072022` on jam `game_jam` / Remote Root.

- `run-backlog-wave.sh` **JOIN=1**: create + start + exit 0. Ticking is supposed to be `wave-supervisor.sh`.
- OUT dir had `cli/{create,start,dry-run}.json` only. **Empty** `ticks/`, `artifacts/`, `worktrees/`.
- Ledger: status **RUNNING**, `nextAction=tick`, RRT-136 PLANNING/`wait-plan`, PLAN outbox **PENDING**, events only create/freeze/start.
- `$WR_SCRATCH/supervisor.pid` **4194095 dead**. Heartbeat age **~3h**, still listing this wave. `wr_live_status.py`: RUNNING, **procs none**.
- `supervisor.log` killers:
  1. `SafetyGateError: WAVE_RUNNER_OPERATOR_ID is empty or unsafe`
  2. `grok CLI fallback refuses Codex PLAN` (`GrokCliWorker.launch` when `intent.agentId === "codex"`)
  3. `OPERATOR_STOP stuck`
- Same live ledger also had **MA-002** PLAN (Codex / hung watchdog) and **MUD-052** REVIEW. Shared supervisor ticks **all** live slices unless `WAVE_SUPERVISOR_WAVE_ID` + `WAVE_SUPERVISOR_REPO` are set. Default join leaves both empty → one bad lane kills RRT.
- After Astra spawned a **targeted** supervisor (`WAVE_RUNNER_OPERATOR_ID=supervisor-wave-runner`, ACP=1, wave+repo pinned): RRT-136 **PLAN SUCCEEDED** via `grok-cli`; wave → **AWAITING_PLAN_GATE**.
- REVIEW then failed ACP: `Unknown agent id "grok"`. `agents_list` has henry/kawazaki/leia/mona/robin — **no `grok`**. REVIEW outbox **RECONCILING**, stage PENDING, no session. 137/138 still PENDING.

## Goal

Waves that admit must keep ticking or fail closed loudly. One bad ticket/lane must not freeze others. ACP agent ids must be real OpenClaw agents or grok-cli fallback must run for Grok PLAN/REVIEW without wedging RECONCILING forever.

## Acceptance

- [x] Shared supervisor cannot die-or-stuck because a **different** wave’s Codex PLAN hit grok-cli. Isolate fail: other live waves keep ticking.
- [x] Empty/unsafe `WAVE_RUNNER_OPERATOR_ID` cannot leave a dead pidfile + RUNNING wave with a pending outbox (WR-046 hole). Boot sets a safe id; unsafe → exit 1 **before** pidfile; stale heartbeat ⇒ not alive and join will respawn.
- [x] Default JOIN supervisor should not require Astra to pass `WAVE_SUPERVISOR_WAVE_ID` to protect a healthy wave from a sibling Codex/MA/MUD zombie.
- [x] ACP `sessions_spawn` must not use OpenClaw agent id `grok` unless that agent exists. Map Grok builders to a configured harness **or** fail closed to grok-cli for PLAN/REVIEW. Unknown agent → stage failed/retry, not infinite RECONCILING.
- [x] Tests: targeted supervisor vs all-live; **stale failing Codex PLAN lane beside a healthy Grok PLAN lane** (failing lane does not stop the healthy one). Fake-CLI regressions at the CLI boundary for direct operator, wrapper, and supervisor (see orchestrate-repos §9).
- [x] Runbook: if `wr_live_status` shows RUNNING/PLANNING/AWAITING_PLAN_GATE and no operator/drain procs, **do not create another wave**; respawn OSS `wave-supervisor.sh` with safe operator id, optionally pinned to that wave. `npm test && npm run quality`. Commit-land + push origin.

## Resolution

Landed 2026-09-07. Per-wave `tickLiveWaves` isolate; `dispatchPending` fail-closes launch throws; receipt-less RECONCILING + recover miss is `lost_spawn`/`unknown_acp_agent`; PENDING is live work; Grok ACP maps to grok-cli unless `agents.list` lists `grok` (no `openclaw.json` edit); empty Node `tick-all` operator id is `supervisor-wave-runner`; `ensure_supervisor` waits for pid+heartbeat and unlinks a dead pidfile. Same-ledger mixed-wave test: `test/wr-051-supervisor-mixed-lane.test.ts`. Verify: `npm test && npm run quality` exit 0.

## Non-goals

- Finishing RRT-136/137/138 product IMPL (jam). This ticket is WR durability.
- Adding a real OpenClaw agent named `grok` in `openclaw.json` (Jason-gated config). WR must work with the current agent set.
- Unrestricted drain / LLM re-drain / overnight.
- Reopening WR-050 path-overlap.

## Evidence paths

- Wave OUT: `$WR_SCRATCH/wave-runs/wave-rrt-bugs-sequential-202609072022/`
- Ledger: `$WR_SCRATCH/ledgers/420df4a8d4e069b3dcf8eb1d22a76fa758b43020a39475d5365eb5097dfd9981.sqlite`
- `$WR_SCRATCH/supervisor.log` + `supervisor.heartbeat` + `supervisor.pid`
- OSS WR: `$PLUGIN_DIR` (openclaw-wave-runner checkout)
- PLAN artifact (after DIY revive): `$WR_SCRATCH/supervisor-artifacts/tmp/wave-runner/wave-rrt-bugs-sequential-202609072022/RRT-136/PLAN.md`
