# WR-046 plan — Supervisor run health, lease adoption, fail-loud ticks

**Ticket:** `issues/WR-046-supervisor-run-health-lease-adoption.md`
**Verify:** `npm test && npm run quality`
**Land:** commit + push origin
**Author:** `JCraw <4335668+jcraw@users.noreply.github.com>`

## Why

WR-042 (`2f2dc84`) shipped a live supervisor that ticks every slice, then forgot the contracts `wave-operator.sh` already had. Two incidents on 2026-09-02/03:

1. **Zombie ticker.** Committed `wave-supervisor.sh` did not set `WAVE_RUNNER_OPERATOR_ID`. Inherited value contained `/`. `tick-all --supervised` hit `SafetyGateError: WAVE_RUNNER_OPERATOR_ID is empty or unsafe`. Loop used `set +e` and slept 20s. `supervisor_alive` was `kill -0 $pidfile`. Join-mode `run-backlog-wave.sh` only inspected. Waves stayed `RUNNING` for ~9 hours. Log: 5,068 SafetyGate stacks + 16 `peek_repo` sqlite opens of `argv[1]` (`-`).
2. **Closeout lost the lease.** Workers completed. Original operator pid died. Supervisor identity ≠ `cli-wave:<WAVE_ID>`. `refreshHeldLeases` skipped. `expireStaleLeases` deleted the writer lease because `pidIsDead`. Settlement `implFenceFailure` → `stale_fence: writer lease missing`. Supervisor spawn also omitted `WAVE_LAND_MODE=apply`, so jam closeout used commit-fence. RRT-133, SL-007, SP2-070, SP2-067 (recovery) failed that way; RRT-134 / SP2-071 failed as deps.

Pidfile-alive is not health. Join is not a second ticker. WR-026 identity-per-wave and WR-042 one-ticker collided without an adoption rule.

## Spec change-set

Product specs in this repo: `docs/OPERATOR-RUNBOOK.md` (live run vs slice, leases, stuck, closeout), `README.md` invariant 3 (writer lease) + WR-042 run paragraph.

Patch on IMPL (not chat memory):

- **Run vs slice:** JOIN=1 enqueue does not leave an inspect loop. Alive = pid + heartbeat.
- **Identity:** join-mode create/start/tick-all use one safe run id (`supervisor-wave-runner`). Solo `WAVE_JOIN_SUPERVISOR=0` keeps `cli-wave:<WAVE_ID>`.
- **Leases:** IMPL-active lease + live ticker with matching run identity → adopt (rewrite pid, refresh TTL). Do not delete solely because create/start pid is `ESRCH`.
- **Closeout:** freeze `landMode` from ticket YAML, else `WAVE_LAND_MODE` at create, else `commit`. Supervisor spawn must export the drain default `apply` for jam. `land-retry` re-acquires the writer lease then closeout.
- **ACP:** open-outbox slot count ignores terminal waves.

## Decisions

| # | Pick |
|---|---|
| D1 | JOIN=1 process identity is `supervisor-wave-runner` (safe charset) for create, start, and `tick-all`. Set in `wave-supervisor.sh` **and** `run-backlog-wave.sh` ensure_supervisor/create. Never inherit a filesystem path. Unsafe/empty at supervisor boot → exit 1 before writing a live loop. Solo `WAVE_JOIN_SUPERVISOR=0` still uses `cli-wave:<WAVE_ID>`. Writer **scope** remains the mutex; identity is who may refresh. |
| D2 | Heartbeat file `$WR_SCRATCH/supervisor.heartbeat`: one line JSON `{ts, pid, rc, liveWaves, lastError}` every loop. `supervisor_alive` requires pid live **and** `now - ts < 3 * TICK_SLEEP`. Stale pidfile is dead; next kick respawns. |
| D3 | Supervisor loop: `tick-all` rc ≠ 0 increments fail streak; log one line `TICK_FAIL streak=N err=…` (not Node stacks). Streak ≥ 5 → `OPERATOR_STOP repeated_tick_fail`, remove pidfile, exit 1. Reuse `nextStuckCount` across live slices: frozen RUNNING + no live outbox → same stop. Inspect success does not reset the fail streak. |
| D4 | JOIN=1 `run-backlog-wave.sh`: `ensure_supervisor` → create → start → `wave-cli status` → **exit 0**. No inspect `while true`. Terminal of a slice is the supervisor + `WAVE_RESULT.json` from tick-all. `WAVE_JOIN_SUPERVISOR=0` keeps today’s operator loop. |
| D5 | `expireStaleLeases`: if lease ticket is IMPL-active (`IMPLEMENTING`/`VERIFYING`/`APPROVED`) **and** current process holder+identity match **or** equal the configured run identity, **adopt** (pid/pidStartTime/expiresAt) instead of delete. TTL-expired with no matching live ticker still expires. Dead pid of a stranger still expires. WR-032 dead-pid test stays for the stranger case. |
| D6 | `refreshHeldLeases` already rewrites TTL for matching identity; tick order stays refresh then expire. After D1, join-mode matches. D5 is the pid-death hole when refresh ran as the wrong id. |
| D7 | Freeze `landMode` onto `FrozenTicket` at create: ticket YAML `land`/`land_mode`, else `WAVE_LAND_MODE`, else omit (commit at tick). Supervisor `ensure_supervisor` exports `WAVE_LAND_MODE=${WAVE_LAND_MODE:-apply}` so jam drain ticks apply even if a ticket was frozen without YAML. Ticket YAML still wins. |
| D8 | `retryImplLand`: if `implFenceFailure` would fire, `acquireLease` as current process (same holder+identity, same ticket/scope) then `finalizeImplLand`. Apply-mode missing lease still DONE (WR-032) after adopt. Durable `APPLY.json`/`LAND.json` `ok:true` still finishes DONE. |
| D9 | Replace inline `peek_repo` `node -` with `process.argv[2]` **or** a `wave-cli list-live --db` helper. One code path. No stdin-script argv footgun. |
| D10 | `countOpenProvider` / ACP admit counts only outbox whose wave is non-terminal. Leftover `LAUNCHED` on CANCELLED/FAILED waves must not fill the global cap of 4. |
| D11 | `wave-cli status` (no `--wave` required): pidfile, heartbeat age, live waves, per-ticket id/stage/status/next_action, last heartbeat error. Missing/stale heartbeat prints `SUPERVISOR_DEAD`. |
| D12 | Tests **exec** `scripts/wave-supervisor.sh` against a fixture: missing/unsafe operator id exits nonzero and does not loop; `tick-all` failing 5 times exits; heartbeat older than threshold ⇒ `supervisor_alive` false. Fixture: worker succeeded, operator pid dead, supervisor identity ticks → ticket DONE not `stale_fence`. `countOpenProvider` ignores terminal-wave outbox. |

## Out of scope

- WR-043 resume PLAN.md + forge verdict → skip PLAN/REVIEW (file already exists). Tonight’s salvage is land-retry, not re-PLAN.
- WR-044 / WR-045.
- OpenClaw OAuth / agentTurn crons. Health is `wave-cli status`, not a Grok turn. xAI token expiry did not cause `stale_fence`.
- LLM orchestrator, unprompted re-drain, overnight poll.

## Files

- `scripts/wave-supervisor.sh` — identity, heartbeat, fail streak, stuck, peek_repo, `WAVE_LAND_MODE`
- `scripts/run-backlog-wave.sh` — alive=heartbeat, spawn env, JOIN=1 enqueue-and-exit
- `scripts/wave-operator.sh` — only if JOIN=0 path still needs the inspect.json self-cp fix
- `scripts/wave-cli.ts` + `src/cli/operations.ts` — `status`, land-retry identity
- `src/core/repo-identity.ts` — already has the regex; boot must call it
- `src/core/lease-release.ts` + `src/core/launch.ts` — adopt vs expire
- `src/core/land-closeout.ts` — land-retry re-acquire
- `src/core/wave-create.ts` / markdown-tracker freeze — landMode from env
- `src/core/acp-slots.ts` — terminal-wave filter (working-tree patch already exists)
- `docs/OPERATOR-RUNBOOK.md` + `README.md` — run health, identity, landMode freeze
- `test/wr-046-supervisor-health.test.ts` (script exec + lease adoption + land-retry + ACP filter)

## Tests

`test/wr-046-supervisor-health.test.ts` plus extend `test/wr-032-rrt-halt.test.ts` / `test/wr-026-apply-authority.test.ts` only if a helper moves.

Named verify: `npm test && npm run quality`.

## Learn

- bite: harness
- candidate: pidfile-alive + identity mismatch → SafetyGate loop then stale_fence; heartbeat + run identity + adopt
- promote: no (until land; then OPERATOR-RUNBOOK)

## Ops salvage (not this IMPL)

2026-09-03: cancel 14:35 re-PLAN slices; supervisor respawn with `WAVE_LAND_MODE=apply` + safe id; verify worktrees; `land-retry` RRT-133 / SL-007 / SP2-070 / SP2-067; enqueue RRT-134 and SP2-071 after board `done`.
