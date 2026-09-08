# WR-051 plan — Supervisor death, mixed-lane poison, unknown ACP `grok`

Status: APPROVED by Astra 2026-09-07 23:49 MST

**Ticket:** `issues/WR-051-supervisor-dead-mixed-lane.md`
**Verify:** `npm test && npm run quality`
**Land:** commit + push origin
**Author:** `JCraw <4335668+jcraw@users.noreply.github.com>`
**This session:** PLAN only. Fresh Grok IMPL later. Do not stamp `APPROVED by Astra`. Do not `kick.sh --phase plan`.

## Why

2026-09-07 wave `wave-rrt-bugs-sequential-202609072022` (RRT-136 → 137 → 138) JOIN=1 create+start+exit 0, then sat **RUNNING** with no operator. WR-046 made a heartbeat and a fail-loud supervisor. It did **not** isolate one bad live slice from the others, and it still treats `PENDING` as idle.

Verified (do not rediscover):

| Fact | Where |
|---|---|
| OUT dir only `cli/{create,start,dry-run}.json`; empty `ticks/`, `artifacts/`, `worktrees/` | `$WR_SCRATCH/wave-runs/wave-rrt-bugs-sequential-202609072022/` — **expected for JOIN=1**; ticks live under `supervisor-artifacts/` / `supervisor-worktrees/` |
| Ledger RUNNING, nextAction=tick, RRT-136 PLANNING wait-plan, PLAN outbox PENDING, events create/freeze/start | shared sqlite `ledgers/420df4a8d4e069b3dcf8eb1d22a76fa758b43020a39475d5365eb5097dfd9981.sqlite` |
| Same ledger also had MA-002 Codex PLAN + MUD-052 REVIEW | ticket + `tick-all` over `liveWaveIds` |
| `supervisor.log` 5068× `SafetyGateError: WAVE_RUNNER_OPERATOR_ID is empty or unsafe` | **WR-046 leftover** in the append-only log (HEAD still `peek_repo` `argv[1]=-`). Not the 23:38 death. |
| `OPERATOR_STOP stuck` then later `TICK_FAIL` `grok CLI fallback refuses Codex PLAN` then `TICK_FAIL` `Unknown agent id "grok"` | log tail lines 40678–40680 |
| Default JOIN leaves `WAVE_SUPERVISOR_WAVE_ID` / `REPO` empty → one `tick-all` for every live wave on that repo ledger | `scripts/wave-supervisor.sh` + `tickLiveWaves` |
| Astra DIY targeted supervisor (`OPERATOR_ID=supervisor-wave-runner`, ACP=1, wave+repo pinned) got RRT-136 PLAN via grok-cli, then REVIEW ACP `grok` → RECONCILING, no session | ops salvage, **not** this IMPL |

Three holes, one incident:

1. **Mixed-lane abort.** `tickLiveWaves` awaits `tickWave` in a bare `for`. `dispatchPending` claims then `worker.launch` with no catch. Codex PLAN hitting `GrokCliWorker` throws (WR-035, keep). Unknown ACP `grok` throws. **The rest of the ledger never ticks.** `tick-all` rc=1. Supervisor `TICK_FAIL` that whole sqlite scope.
2. **Stuck suicide on PENDING.** `hasLiveOutbox` is CLAIMED/LAUNCHED/RECONCILING only. ACP slot count already treats PENDING as live. Frozen RUNNING + PENDING PLAN + unchanged fingerprint → `OPERATOR_STOP stuck`, trap may drop pidfile, heartbeat goes stale, wave stays RUNNING. JOIN already exited 0. Nobody respawns until a human.
3. **Unknown OpenClaw agent `grok`.** `OpenClawGatewayAcpSpawn` always sends `agentId: "grok"` for Grok PLAN/REVIEW/IMPL. Host `agents_list` is henry/kawazaki/leia/mona/robin — **no grok**. Spawn throws. Claimed row has no receipt. `reconcile` marks RECONCILING, `recover` misses, **`continue`**. Infinite RECONCILING. Do **not** add `grok` to `openclaw.json`.

WR-046 D12 isolation test is **two sqlite files**. This incident is **one ledger, two waves**. That test would stay green today.

## Spec change-set

Product specs: `docs/OPERATOR-RUNBOOK.md` (live run vs slice, stuck, ACP agents, dead-supervisor respawn). README invariant: one ticker; one bad lane must not freeze others.

## Decisions

| # | Pick |
|---|---|
| D1 | **Per-wave isolate inside `tickLiveWaves`.** `try/catch` each `tickWave`. Launch/ACP/Codex-CLI throws fail **that wave’s current CLAIMED/RECONCILING row** (`markFailed`) and continue the next `waveId`. `tick-all` returns rc 0 when the CLI process itself is healthy even if some views record isolated errors. Process-level `SafetyGateError` before the loop still fails the process. |
| D2 | **`dispatchPending` must not throw out of `tickWave` on worker.launch failure** (keep `CrashInjectedError`). Catch, `markFailed` the claimed row, stamp ticket result, let existing hop/retry/stageDeathNoRetry decide. Sibling PENDING rows in **other waves** still dispatch this tick. Same-wave later PENDING may continue. |
| D3 | **Receipt-less RECONCILING is dead, not sleep.** `reconcile`: no `receiptJson` and `recover()` miss → `markFailed` with a stable reason (`lost_spawn` / `unknown_acp_agent`). Do not `continue` forever. Extend `stageDeathNoRetry` for `Unknown agent id` and `grok CLI fallback refuses Codex PLAN` so we do not burn hops on a host misconfig. |
| D4 | **Never `sessions_spawn` OpenClaw agent id `grok` unless a probe says that agent exists.** Default on this host: Grok PLAN/REVIEW/IMPL/FIX/VERIFY → **grok-cli** when `--launcher` / `WAVE_RUNNER_LAUNCHER` is set; else fail the **stage** `grok_agent_missing` (not the supervisor). Mona stays subagent. Codex PLAN stays ACP `agentId: "codex"` with **no** grok-cli fallback (WR-035). No `openclaw.json` edit. Optional override `WAVE_GROK_ACP_AGENT_ID` only if probe lists it. |
| D5 | **Routed product worker.** `resolveProductWorker` must not bind every stage to `GrokAcpWorker` just because an ACP port exists. ACP port + launcher: Codex/Mona → ACP; Grok → grok-cli unless D4 probe hits. ACP port, no launcher, grok agent missing → stage fail-closed, not `MissingAcpSpawnWorker` abort of `tick-all`. |
| D6 | **Operator id.** Node `resolveCliOperatorIdentity`: supervised `tick-all` / no `--wave` + empty env → `RUN_OPERATOR_ID` (`supervisor-wave-runner`), matching bash. Unsafe non-empty still `SafetyGateError` (no loop). `ensure_supervisor`: after `nohup`, **do not treat parent `$!` as healthy**; wait until `supervisor_alive` (pid **and** fresh heartbeat) or fail the spawn and **unlink** the pidfile. Child still `resolve_run_operator_id` before writing pidfile. JOIN=1 create/start keep the same run id. |
| D7 | **PENDING is live work** for stuck. `LIVE_OUTBOX_STATES` / `hasLiveOutbox` include `PENDING` (same set as `acp-slots.ts`). `OPERATOR_STOP stuck` cannot fire while any PENDING/CLAIMED/LAUNCHED/RECONCILING exists. Frozen RUNNING with **no** outbox still stops (WR-019). |
| D8 | **Default JOIN stays unpinned.** Do not require `WAVE_SUPERVISOR_WAVE_ID` to protect a healthy Grok wave. Pin remains an ops opt-in (Astra DIY). Isolation is D1–D3, not a second supervisor per wave. |
| D9 | **Runbook:** `wr_live_status` / `wave-cli status` shows RUNNING, PLANNING, or AWAITING_PLAN_GATE and **no** operator/drain procs → **do not create another wave**. Respawn OSS `scripts/wave-supervisor.sh` with `WAVE_RUNNER_OPERATOR_ID=supervisor-wave-runner`, `WAVE_RUNNER_ACP=1`, optional pin. `SUPERVISOR_DEAD` + live waves is the signal. |

## Out of scope

- RRT-136/137/138 jam product IMPL, plan-gate stamp, babysitting the DIY supervisor.
- Adding OpenClaw agent `grok` / editing `openclaw.json`.
- Weakening `GrokCliWorker` Codex PLAN refuse (WR-035). Isolate around it.
- Unrestricted drain, LLM re-drain, overnight, WR-050 path-overlap, WR-044 host-fail retry (except the no-retry strings in D3).
- Replacing JOIN with per-wave inspect loops.

## Read first

| Path | Change |
|---|---|
| `src/core/run-supervisor.ts` | D1 per-wave try/catch; collect isolated errors onto the returned views, do not abort the list. |
| `src/core/launch.ts` | D2 catch `worker.launch`; D3 receipt-less recover miss → `markFailed`. |
| `src/core/settlement.ts` | D3 `stageDeathNoRetry` for unknown ACP agent + grok-cli Codex refuse. |
| `src/core/operator-loop.ts` | D7 PENDING in `LIVE_OUTBOX_STATES` / `hasLiveOutbox`. |
| `src/runtime.ts` | D5 routed worker; launcher + ACP coexist. |
| `src/adapters/openclaw-acp.ts` | D4: do not spawn `agentId: "grok"` unless probe/override says it exists. Fail with `Unknown agent id "grok"` **before** invoke if mapped away. |
| `src/adapters/acp-worker.ts` | Grok stages may not call ACP spawn when routed to CLI. Codex/Mona unchanged. |
| `src/core/repo-identity.ts` | D6 empty env on supervised no-wave → `RUN_OPERATOR_ID`. |
| `scripts/wave-supervisor.sh` | Heartbeat/stuck already exist; D7 via tick JSON `has_live_work_views` must count PENDING (script Python **and** TS). |
| `scripts/run-backlog-wave.sh` | D6 `ensure_supervisor` wait-for-alive / unlink dead pidfile. Keep default empty `WAVE_SUPERVISOR_WAVE_ID`. |
| `scripts/wave-operator.sh` | Pass ACP/launcher/operator id unchanged (orchestrate-repos §9). No new identity scheme. |
| `scripts/supervisor-health.sh` | Keep charset assert; empty still defaults `supervisor-wave-runner`. |
| `docs/OPERATOR-RUNBOOK.md` | Dead supervisor respawn; mixed-lane; grok-cli map; PENDING=live; do not add grok agent. |
| `test/wr-051-supervisor-mixed-lane.test.ts` | **new.** See Tests. |
| `test/wr-046-supervisor-health.test.ts` | Keep two-sqlite isolation. Do not replace it. |
| `test/wr-035-plan-worker.test.ts` `test/openclaw-acp.test.ts` `test/operator-contract.test.ts` | Stay green. No skip. Codex CLI refuse stays. |

## Live

- `tickLiveWaves` (`src/core/run-supervisor.ts`): sequential `await tickWave` with no catch.
- `dispatchPending`: claim → `worker.launch` → throw kills `tickWave` → kills `tick-all`.
- `reconcile`: receipt-less `continue`.
- `GrokCliWorker.launch`: `intent.agentId === "codex"` throws. Correct for CLI; fatal today for mixed `tick-all` when ACP is off / launcher-only.
- `OpenClawGatewayAcpSpawn.spawn`: `agentId: input.agentId` (grok). Host has no such agent.
- `resolveProductWorker`: `if (input.acp) return new GrokAcpWorker` — launcher never used when ACP port exists.
- `resolveCliOperatorIdentity`: empty env + no waveId → throw (not default). Bash already defaults. Direct `tick-all --supervised` without env still SafetyGate.
- `ensure_supervisor`: `echo $! > pidfile` then `sleep 0.3` with no heartbeat check.
- Supervisor stuck Python `has_live_work_views`: CLAIMED/LAUNCHED/RECONCILING only.
- JOIN=1: create+start+`wave-cli status`+exit 0. Ticks are supervisor-owned.

## Do not open

- `openclaw.json` / Gateway agent config.
- Jam `issues/remote_root/**` / RRT product files.
- `src/core/plan-worker.ts` routing of Codex vs Grok **except** spawn mapping after `stageAgentId` (keep UX→mona, PLAN+codex→codex, else grok).
- SAFETY drain flags, lease adopt (WR-046), land-retry, WR-050 prefixes.
- Crawmak forge kick / Astra stamp.

## Approach

1. Operator-loop PENDING=live + tests (`operator-contract`).
2. `tickLiveWaves` isolate + `dispatchPending`/`reconcile` fail-close (unit, in-process mock workers).
3. Routed worker + ACP grok map/fail (fake Gateway: unknown grok → no spawn args `agentId: grok` when mapped; Codex spawn still `codex`).
4. Script: `ensure_supervisor` alive-wait; fake-CLI at **wave-cli**, **wave-operator.sh**, **wave-supervisor.sh** (targeted and all-live).
5. Runbook. `npm test && npm run quality`.

## Tests

New `test/wr-051-supervisor-mixed-lane.test.ts` plus script exec (fake-CLI, not live Gateway).

**In-process (controller / tickLiveWaves):**

- Same sqlite: wave A Codex PLAN worker throws `grok CLI fallback refuses Codex PLAN`; wave B Grok PLAN launches and reaches LAUNCHED/SETTLED. A is fail-closed. `tick-all` does not throw. B not left PENDING.
- Same sqlite: Grok REVIEW ACP spawn returns unknown agent `grok`. Outbox **FAILED** (or hop-exhausted FAILED), never leftover RECONCILING without session. Next tick of a sibling Grok PLAN still runs.
- Receipt-less RECONCILING + recover miss → FAILED, not still RECONCILING.
- PENDING PLAN outbox + unchanged fingerprint → `hasLiveWork` true → `nextStuckCount` resets (not stuck).

**Fake-CLI boundary (orchestrate-repos §9) — three entrypoints, same contract:**

| Surface | Prove |
|---|---|
| Direct `node dist/scripts/wave-cli.js tick-all --supervised` | Empty `WAVE_RUNNER_OPERATOR_ID` uses `supervisor-wave-runner` (no SafetyGate). Unsafe id exits ≠0, no loop. |
| `scripts/wave-operator.sh` | Forwards `--supervised`, ACP/launcher flags; does not wipe JOIN run id. |
| `scripts/wave-supervisor.sh` all-live | Two ledgers **and** (via fake tick-all that encodes two waves in one db if cheaper: supervisor still one tick-all per sqlite) failing Codex lane does not `OPERATOR_STOP` / kill the process while the healthy Grok lane returns 0. Targeted `WAVE_SUPERVISOR_WAVE_ID` still uses `tick` not `tick-all`. |

Keep WR-046 two-sqlite test. Add **same-ledger** coverage in wr-051 so that test cannot be the only isolation proof.

Do not delete WR-035 Codex refuse asserts. Do not skip `test/wr-037-ux-review.test.ts` REVIEW=grok / UX=mona.

Named verify: `npm test && npm run quality` in the OSS Wave Runner checkout. Exit 0 in CLOSEOUT. No `--force`.

## Runbook (land in OPERATOR-RUNBOOK)

If `wr_live_status.py` or `wave-cli status` shows RUNNING / PLANNING / AWAITING_PLAN_GATE and **no** operator/drain/supervisor procs (`SUPERVISOR_DEAD` or stale heartbeat):

1. Do **not** `run-backlog-wave.sh` a second wave for the same tickets.
2. Respawn OSS only:

```bash
# PLUGIN_DIR = OSS Wave Runner checkout (not the workspace plugin copy)
# WR_SCRATCH = Wave Runner scratch on the 7.3T data disk
export WAVE_RUNNER_OPERATOR_ID=supervisor-wave-runner WAVE_RUNNER_ACP=1 WAVE_LAND_MODE=apply
# optional pin:
# export WAVE_SUPERVISOR_WAVE_ID=<wave> WAVE_SUPERVISOR_REPO=<repo>
nohup bash "$PLUGIN_DIR/scripts/wave-supervisor.sh" >>"$WR_SCRATCH/supervisor.log" 2>&1 &
# wait until wave-cli status prints SUPERVISOR_OK
```

3. Workspace plugin path is still refused. Do not edit `openclaw.json` to invent agent `grok`.

## Ops salvage (not this IMPL)

Do not cancel RRT-136 in this ticket. DIY targeted supervisor may keep the PLAN artifact. IMPL of WR-051 is Wave Runner durability only.

## Learn

- bite: harness
- candidate: shared `tick-all` + launch throw + PENDING-not-live + ACP agentId grok missing → RUNNING with dead pid; isolate per wave, fail-close spawn, grok-cli map
- promote: no (until land; then OPERATOR-RUNBOOK)
