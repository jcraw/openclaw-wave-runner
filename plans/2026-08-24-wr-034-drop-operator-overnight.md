# WR-034 plan — drop operator-overnight

**Ticket:** `issues/WR-034-drop-operator-overnight.md`  
**Forge mirror:** `crawmak/tmp/workers/WR-034/PLAN.md`  
**Verify:** `npm test && npm run quality`  
**Land:** `commit` + push origin  
**Author:** `JCraw <4335668+jcraw@users.noreply.github.com>`

PLAN ONLY. No SAFETY on. No schema bump. No sibling-repo copy.

## 1. Goal

A kick is a kick. Clock time is not a gate. Delete the operator-overnight mode. Keep the real red line: unprompted re-drain and LLM backlog polling stay off.

## 2. Findings

| # | Fact | Gap |
|---|---|---|
| F1 | Controller `MAX_WALL_MS` / `supervisedMaxWallTimeMs` already default **0**. Stage watchdogs 45m PLAN / 90m IMPL, token/launch caps, stuck ticks, human hold, emergency-stop remain. | Shell loop in `run-backlog-wave.sh` still defaults `WAVE_WALL_S=21600` and `FATAL wall`s. |
| F2 | `OVERNIGHT=1` only sets that shell `WALL_S=0`. Drain scripts never pass TS `operatorOvernight`. | Operator receipts treat overnight as a mode (`overnight OFF, apply, no push`). Astra echoes the env. |
| F3 | `assertBoundedWaveRequest({ overnight: true, operatorOvernight: true })` is the only live use of `operatorOvernight` — tests. Manifest always pins `overnight: false`. | Dead API + a 6h wall invented a second “overnight.” |
| F4 | Real forbidden behaviors already have names: `unrestrictedDrain`, `recurringLlmPolling`, explicit ticket list, `operatorActionRequired`. | Operator docs still say “daytime / overnight kick.” |

## 3. Decisions

| # | Pick |
|---|---|
| D1 | Default `WAVE_WALL_S=0` in `run-backlog-wave.sh`. Explicit `WAVE_WALL_S>0` still `FATAL wall`. Timeout knob, not time of day. |
| D2 | `OVERNIGHT=1`: if `WAVE_WALL_S` unset, alias to 0 + stderr deprecation (`use WAVE_WALL_S=0; OVERNIGHT is not a mode`). If `WAVE_WALL_S` is set, it wins. Do not require `OVERNIGHT` for long runs. |
| D3 | `drain-eligible.sh`: stop defaulting/exporting `OVERNIGHT`. Start banner: `REPO=… WALL_S=… MAX_PARALLEL=…` (WALL_S from env or 0). Comment: operator drain, no LLM loop. |
| D4 | Delete `SAFETY.operatorOvernightDrainAllowed` and `input.operatorOvernight`. `overnight: true` always throws. Keep `SAFETY.overnightEnabled` and `autonomousOvernightEnabled` compile-time **false**. |
| D5 | FrozenManifest `overnight: false` stays schema 1. `validateManifest` still refuses a true pin. Do not rename the wire field. |
| D6 | Projection + Gateway `overnightEnabled: false` stay (CrawDash `setdefault`). Do not rename this ticket. |
| D7 | `describeReplacementPath().overnight` string: unprompted re-drain remains off; operator kick has no clock-time mode. Update the `/operator/i` assert if the new string drops that word. |
| D8 | Operator docs (README, SECURITY, CONTRIBUTING, OPERATOR-RUNBOOK, comments on `wave-operator.sh` / `wave-cli.ts` / `safety.ts`): one drain command; unprompted re-drain / LLM poll / unrestricted drain stay off. Delete daytime vs overnight recipes and `OVERNIGHT=1 nohup` sample. Optional `WAVE_WALL_S` documented as a timeout. |
| D9 | Do not rewrite historical issues/plans/ADRs. `markdown-tracker` skip of `OVERNIGHT_HANDOFF.MD` stays (jam filename, not this flag). |

Hung drain after D1 still stops via stage watchdogs, `MAX_TOKENS` / `MAX_LAUNCHES`, stuck detector, human hold, emergency-stop. That is the intended unattended kick. A desk timeout is `WAVE_WALL_S=3600`, not a second mode.

## 4. Tests (`test/wr-034-operator-wall.test.ts` + edit existing)

| Contract | Assert |
|---|---|
| default shell wall | `run-backlog-wave.sh` default `WAVE_WALL_S` is 0, not 21600 |
| explicit wall | script still has `FATAL wall` when `WALL_S != 0` |
| OVERNIGHT alias | `OVERNIGHT=1` still zeros wall when `WAVE_WALL_S` unset; deprecation string present |
| drain banner | `drain-eligible.sh` start echo has no `OVERNIGHT=` |
| overnight request | `assertBoundedWaveRequest({ overnight: true, ticketIds: ["T-1"] })` throws |
| no operator escape | `operatorOvernight` is not a parameter; old doesNotThrow path is deleted |
| pins stay off | `SAFETY.overnightEnabled === false`; capabilities/projection `overnightEnabled: false` |
| replacement copy | `describeReplacementPath().overnight` does not describe a clock-time mode |
| existing phase 4/5/6 | `overnightEnabled === false` asserts stay; do not skip |

Also rewrite `test/safety-backup.test.ts` line that allows `overnight: true` + `operatorOvernight: true` — that must throw.

## 5. Touched set

**Must:** `scripts/run-backlog-wave.sh`, `scripts/drain-eligible.sh`, `src/domain/safety.ts`, `src/adapters/studio.ts`, `docs/OPERATOR-RUNBOOK.md`, `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `scripts/wave-operator.sh` (comment), `scripts/wave-cli.ts` (comment), `test/wr-034-operator-wall.test.ts`, `test/safety-backup.test.ts`, `test/phase4-ops.test.ts`

**May:** `src/core/wave-projection.ts` / `src/index.ts` comments only; `src/domain/types.ts` comment on the frozen `overnight: false` pin

**Must not:** `SAFETY.*` flipped on; manifest schema; `src/core/manifest.ts` pin logic beyond comment; jam/mud/crawmak/Astra trees; CrawDash; `scripts/cleanup-scratch.sh`; historical WR-015 rewrite; `OVERNIGHT_HANDOFF.MD` skip list

## 6. Out of scope

- Crawmak `AGENTS.md` red-line wording (forge)
- jam `ORCHESTRATION.md` / Astra `CONTROL_PLANE.md` kick phrasing (sibling / OpenClaw workspace)
- Renaming projection `overnightEnabled` (follow-up if CrawDash is ready)
- Cron, LLM poll, unrestricted drain, production worker launch

## 7. Loop

1. This PLAN + ticket (this turn). Stop.
2. Crawmak review → `crawmak/reviews/WR-034.md`. Verdict approve / approve-with-conditions **is** the approve. Do not invent Astra.
3. Fresh IMPL on this plan: `npm test && npm run quality` → commit-land WR `main` + push origin.

## Learn

- bite: none
- candidate: operator “overnight” was a 6h shell wall, not a clock → do not name timeouts after time of day
- promote: no
