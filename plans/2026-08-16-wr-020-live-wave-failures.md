# WR-020 plan — live supervised-wave failures

**Ticket:** `issues/WR-020-investigate-live-wave-failures.md`
**Stamp:** `APPROVED by Jason` (2026-08-16). Do not invent Astra.
**Verify (impl):** `npm test`
**Land gate:** `npm test && npm run quality`
**Author:** `JCraw <4335668+jcraw@users.noreply.github.com>` + push `origin`
**Evidence (cite only, do not edit):** `~/.openclaw/workspace/projects/agent-backlog-wave-runner/tmp/batch-{wr2,jam2,mud}-20260816*`

PLAN ONLY. No product code this turn.

## 1. Goal

Wave Runner stops killing healthy long IMPL, keeps full verify output, and fail-closes hung PLAN. Product jam/mud tickets stay Astra’s lane.

## 2. Findings (reviews-style)

**Verdict:** three runner bugs, one stacked PLAN hang. Not product-ticket work.

| # | Wave | Fact | Cause in this tree |
|---|---|---|---|
| F1 | `BL-WR-006-20260816140320`, `PAR-board-remote_root-RRT-013-140320` | inspect: `IMPLEMENTING` + outbox `LAUNCHED`; `operator.log` → `OPERATOR_STOP stuck`. Resume `STUCK_TICKS=0` → `WAVE_OK` | `progressFingerprint` = status/revision/outbox.state/lease key-holder-ticketId. No worker liveness. `refreshHeldLeases` bumps `expiresAt` but that field is **not** hashed. Default `STUCK_TICKS=20` × `TICK_SLEEP=20s` ≈ 400s. |
| F2 | `PAR-board-rink_rush-RR-070-140320` | IMPL `terminal.json` succeeded + diffs; controller `verify failed`; WAVE_VERIFY = `"Command failed: bash -lc python3 tools/codex_verify.py --path game/jams/rink_rush"`; retries exhausted → `WAVE_BAD FAILED` | `GitWorkspace.verify` catch stores only `Error.message`. Node `stdout`/`stderr`/`status` dropped. No timeout field. Cannot tell product flake vs runner timeout. |
| F3 | `PAR-prefix-MUD-MUD-037-145205` | 185 ticks, `PLANNING`/`wait-plan`, launches=1. `PLAN/1/PLAN.md` (7606 B) + matching `terminal.json` `status=succeeded`. Hash hex equals file; stored as `sha256:<hex>` | (a) `GrokAcpWorker.inspect` returns `running` if ACP queued/running — **never reads artifacts**. (b) `inspectStageArtifacts` exact-compares `terminal.hash` to unprefixed hex → `unknown`. Observe never settles. Operator restart resets `STUCK_N`. Serial lane blocked. |

Keep existing artifact-over-cancel test. Do **not** treat leftover `PLAN.md` in an IMPL dir as IMPL success (`acp-worker` “stale PLAN artifacts” test stays).

## 3. Decisions

| # | Pick |
|---|---|
| D1 | **Do not** default `STUCK_TICKS=0`. Exempt stuck increment when any outbox is `CLAIMED`/`LAUNCHED`/`RECONCILING`. Frozen `RUNNING` with no open outbox still stops (WR-019). Do **not** hash `lease.expiresAt` (would hide hung IMPL). |
| D2 | Artifact-first inspect: matching **same-stage** terminal + required artifact → `succeeded` even if ACP still `running`. |
| D3 | Normalize optional `sha256:` prefix (case-insensitive) before hash compare. |
| D4 | Stage watchdog **after** `observeLaunched`: remaining LAUNCHED/RECONCILING age (`outbox.createdAt`) > `WAVE_PLAN_WALL_MS` (default 45m) / `WAVE_IMPL_WALL_MS` (default 90m) → `worker.cancel` + settle `failed` reason `stage_watchdog: <stage> hung`. WR-010 retry then applies. `0` disables. Operator then `WAVE_BAD` with `ticket.result`. |
| D5 | `WAVE_VERIFY.json`: `{ok,command,stdout,stderr,output,exitCode,signal,timedOut,durationMs}`. `execFileSync` timeout `WAVE_VERIFY_TIMEOUT_MS` default `300000`. Fail snippet prefix `runner_verify:` (timeout/ENOENT/spawn) vs `product_verify:` (nonzero + captured body). Do not change jam `codex_verify` / Godot policy. |
| D6 | Extract rather than grow `settlement.ts` / `tick.ts` (2500-token ceiling; do not baseline them). New `src/core/stage-watchdog.ts` + small verify helper in workspace or `src/adapters/verify-exec.ts`. |

## 4. Approach

### P0.1 — stuck vs live LAUNCHED
- `hasLiveOutbox(view)` + `nextStuckCount(..., live)` in `operator-loop.ts`. Live → reset or never `stuck`.
- Same predicate in `wave-operator.sh` + `run-backlog-wave.sh` Python (outbox state).
- Runbook: live LAUNCHED is not stuck; hung stage is the watchdog.

### P0.2 — verify capture
- `GitWorkspace.verify` uses `error.stdout`/`stderr`/`status`/`signal`; `ETIMEDOUT` → `timedOut`.
- `impl-verify.ts` fail string includes classify + proof path (still `clipReason` 500 on ticket.result; full body stays on disk).
- MockWorkspace unchanged (`"false"` still fails).

### P0.3 — hung PLAN / dead ACP
- `stage-artifacts.ts`: `normalizeArtifactHash`.
- `acp-worker.ts`: check artifacts **before** ACP running short-circuit.
- `stage-watchdog.ts` called from `tickWave` after `observeLaunched`. Cancel then `settleOutbox(..., "failed", ..., "stage_watchdog: ...")`. No new ticket status.

### P1 — docs + findings stay in this plan
- `docs/OPERATOR-RUNBOOK.md`: D1/D4/D5 env knobs. Cite the three wave ids.
- Do not rewrite jam/mud issue files.

## 5. Tests (`test/wr-020-live-wave.test.ts` + extend)

| Contract | Assert |
|---|---|
| live IMPL not stuck | same fingerprint, outbox LAUNCHED, threshold 3 → `stuck: false` |
| WR-019 frozen still stuck | no open outbox, same RUNNING fingerprint N times → `stuck: true` |
| plan-gate | unchanged, no increment |
| sha256 prefix | `hash: "sha256:<hex>"` + matching PLAN.md → `succeeded` |
| artifact-first | ACP `running` + matching PLAN terminal/artifact → `succeeded` |
| stale PLAN in IMPL | ACP running + only PLAN.md in IMPL dir → still `running` |
| watchdog | fake worker stays running, no artifacts, clock past PLAN wall → ticket `REVISING` or `FAILED` with `/stage_watchdog/`; wave not infinite RUNNING |
| watchdog 0 | wall env 0 → no fail |
| verify capture | `echo err >&2; exit 2` → WAVE_VERIFY has stderr + `exitCode: 2`, not only `Command failed` |
| verify timeout | `sleep 30` + timeout 50ms → `timedOut: true`, `runner_verify:` |
| lease-on-fail | do not weaken WR-019 lease/release tests |

## 6. Touched set

**Must:** `src/core/operator-loop.ts`, `src/core/stage-watchdog.ts` (new), `src/core/tick.ts` (one call), `src/core/impl-verify.ts`, `src/adapters/workspace.ts`, `src/adapters/stage-artifacts.ts`, `src/adapters/acp-worker.ts`, `scripts/wave-operator.sh`, `scripts/run-backlog-wave.sh`, `docs/OPERATOR-RUNBOOK.md`, this plan, `test/wr-020-live-wave.test.ts`, `test/operator-contract.test.ts`, `test/acp-worker.test.ts`

**May:** `src/adapters/verify-exec.ts` if workspace would cross 2500; `src/core/launch.ts` only if cancel-from-watchdog needs a helper.

**Must not:** `lease-release.ts` rules, WR-017 identity, SAFETY/overnight/drain, jam/mud ticket bodies, Godot/codex_verify product policy, `STUCK_TICKS` default 0, hashing `expiresAt`.

## 7. Out of scope

- Finishing RR-070 / MUD-037 product work (Astra)
- Overnight / unrestricted drain
- Soft residual-allowlist for rink_rush ObjectDB noise
- Multi-ticket same-scope policy beyond existing one-ticket-per-scope runbook
- Gateway ACP transport rewrite
- Merge/push this plan turn

## 8. Land

One commit preferred. Impl session: `npm test` then `npm test && npm run quality`; public author; `env -u GH_TOKEN git push` if session PAT 403 (WR-018).

## Learn
- bite: none
- candidate: none
- promote: no


Status: APPROVED by Jason 2026-08-16
