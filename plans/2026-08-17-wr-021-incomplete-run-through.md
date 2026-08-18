# WR-021 plan — incomplete run-through

**Ticket:** `issues/WR-021-incomplete-run-through-land-and-research.md`
**Forge mirror:** `crawmak/tmp/workers/WR-021/PLAN.md`
**Stamp:** APPROVED by Jason 2026-08-17 (implement the recommended slice: WR-021 honesty + hard preflight before paid PLAN).
**Verify (impl):** `npm test && npm run quality`
**Author:** `JCraw <4335668+jcraw@users.noreply.github.com>` + push `origin`
**Evidence (cite only, do not edit):** `tmp/drain-eligible-20260816235052/`

IMPL turn. Honesty receipts + fail-before-spend. No Remote Root product. No IMPL-only profile. No bash-operator rewrite.

## 1. Goal

Wave Runner runs a supervised lane **through land or an actionable miss**. Green IMPL + dirty primary must not look like a mute product failure. Research tickets must not be enqueued with empty verify. Drain “finished” must not mean “all DONE.”

Do **not** implement Remote Root (RRT-028…031) here.

## 2. Findings (reviews-style)

**Verdict:** three runner honesty/admit bugs. Product work on RRT-028 is stranded and is Astra’s lane.

| # | Wave / log | Fact | Cause in this tree |
|---|---|---|---|
| F1 | `PAR-board-remote_root-RRT-028-235101` `cli/tick-319.json` | `wave.status=FAILED`, ticket `FAILED`, `nextAction: inspect`. Verify commit in worktree. `LAND.json` `ok:false` error `primary dirty overlaps land:` jam files + `issues/BOARD.md` + ticket md. `CLOSEOUT.md` exists. Jam ticket still `open`. `baseSha=4f07a87c`. | `executeLandToMain` (`src/adapters/land-git.ts`) fail-closes incoming ∩ dirty (WR-017). Correct safety. No recovery receipt, no operator actions, no `CLOSEOUT_DEBT` label. Board `done` is not consulted (good) and not contradicted (operator confusion). |
| F2 | `run/board-remote_root/lane.log` end | After `WAVE_BAD FAILED` / `FAIL RRT-028`, lane starts RRT-029. `WaveError: missing_verify: RRT-029` at `assertTicketsHaveVerify`. `FAIL RRT-029`. | WR-019 create belt. `drain-eligible.sh` selector only checks open + `agent_eligible` + deps. Empty `verify_command: ""` is eligible. `run-backlog-wave.sh` dry-run `\|\| true`. |
| F3 | `drain.log` | `ALL LANES FINISHED 2026-08-17T02:12:11-07:00`. `wait pid \|\| true`. `drain-eligible.sh` exit 0. | `run-backlog-parallel.sh` always prints finished. No per-ticket terminal. |
| F4 | `eligible.txt` | Only `RR-073`, `RRT-028`, `RRT-029`. | RRT-030/031 never selected (deps / not eligible). Not a serial-create strand. |

## 3. Decisions

| # | Pick |
|---|---|
| D1 | Keep WR-017 overlap fail-closed. No stash. Do not treat board-done as primary clean. |
| D2 | Recovery lives on `LAND.json` (`recovery:{reason,overlap,dirty,incoming,worktree,tip,operator[]}`) + artifact `kind: land-recovery`. Ticket stays `FAILED`. `result` prefix `CLOSEOUT_DEBT:` + proof path. **No** new `TicketStatus` / wave status `REBASE_OR_RELAND`. |
| D3 | Pre-IMPL overlap via new `WorkspaceAdapter.primaryDirtyOverlap` (git in adapters only). Prefixes from pure `scopePaths(writerScope, sourcePath)`: `game:X`→`game/jams/X/`, `board:X`→`issues/X/`, plus ticket `sourcePath`. Do **not** treat dirty `issues/BOARD.md` as pre-IMPL fail unless it is `sourcePath`. dry-run: warning blocker. **Hard preflight:** drain `dry-run` refuses create/start (no paid PLAN) when that warning is present, unless `WAVE_PRIMARY_DIRTY=allow`. PLAN and IMPL queue: fail-closed unless allow. Land still uses exact incoming ∩ dirty (BOARD.md can still fail land). |
| D4 | Keep empty verify = `missing_verify` at dry-run and create. **No** `verify_kind: noop`. Research/spike: non-empty `verify` / `verify_command` required (recipe `test -s <NOTE-or-digest>`). Optional `verify_kind: research` is documentation/tag only. |
| D5 | Selector fail-at-select: do not enqueue; emit `SKIPPED missing_verify <id>`. Lane already continues after `FAIL` (F2). Keep create belt. |
| D6 | Drain/lane terminal table. Exit **1** if any kicked ticket is not `DONE` (land.ok). `WAVE_DRAIN_BEST_EFFORT=1` → exit 0 after table. Ban success-only `ALL LANES FINISHED`. |
| D7 | P1: `land-retry` CLI and/or `WAVE_LAND_RETRY=1` (one re-`landToMain`, no stash). Operator must clear overlap first. |
| D8 | Extract new files. Do not baseline-grow `land-git.ts`, `wave-create.ts`, `land-closeout.ts`, `tick.ts` past 2500 tokens. |

## 4. Approach

### P0.1 — recovery receipt + CLOSEOUT_DEBT
- Overlap `fail()` writes `recovery` extra.
- `finalizeImplLand`: if `!land.ok` and a verify proof exists → `CLOSEOUT_DEBT: land failed: …` (clip 500).
- Worktree stays registered (WR-017).

### P0.2 — admit / pre-IMPL overlap + hard preflight
- `collectAdmitBlockers` adds `primary_dirty_overlap` warnings (create still ok for inspect).
- Drain `run-backlog-wave.sh` treats that warning as refuse-to-start (no create) unless `WAVE_PRIMARY_DIRTY=allow`.
- Before paid PLAN **or** IMPL launch: overlap ∩ scope prefixes → `FAILED` / no outbox, unless allow-env.

### P0.3 — select-time verify
- Same empty/bool rules as `yamlVerifyCommand`.
- Extract selector enough to test with a fixture `issues/` tree.

### P0.4 — honest summary
- `WAVE_RESULT.json` per wave; `LANE_SUMMARY.jsonl` + drain rollup; non-zero default exit.

### P1 — runbook + optional retry
- How to declare research verify.
- How to recover dirty-overlap: commit or stash **unrelated** dirt; or clean primary then rebase wave tip / `land-retry`. Never stash overlapping land paths.

## 5. Tests (`test/wr-021-run-through.test.ts` + extend `land-closeout` / `wr-019`)

| Contract | Assert |
|---|---|
| recovery receipt | overlap fixture → `ok:false`, `recovery.overlap` matches, `operator` mentions commit/stash-unrelated **and** rebase, HEAD unchanged |
| CLOSEOUT_DEBT | verify green + land overlap → `FAILED` + `/CLOSEOUT_DEBT/` + not `DONE` |
| unrelated dirt | still lands |
| pre-IMPL | dirty jam path + `game:` scope → no IMPL launch |
| allow-env | launches; land still fail-closed |
| BOARD.md only | no pre-IMPL fail for jam scope |
| dry-run warning | `admitBlockers` includes `primary_dirty_overlap` |
| WR-019 belt | omit verify → create/dry-run `missing_verify` |
| select skip | empty verify not enqueued; reason names ticket id |
| drain exit | one FAILED → exit 1; best-effort → 0 + table |
| no regress | WR-013 land-on-done, WR-017 no-stash, WR-020 live-LAUNCHED / verify capture |

## 6. Touched set

**Must:** `src/adapters/land-git.ts`, `src/adapters/workspace.ts`, `src/adapters/mock-workspace.ts`, `src/core/ports.ts`, `src/core/land-closeout.ts`, `src/core/wave-create.ts`, IMPL-gate call site (`admission.ts` or `tick.ts`), new `src/adapters/primary-overlap.ts`, `src/core/land-recovery.ts`, `src/domain/scope-paths.ts`, `scripts/drain-eligible.sh`, `scripts/run-backlog-parallel.sh`, `scripts/run-backlog-wave.sh`, `docs/OPERATOR-RUNBOOK.md`, this plan, `test/wr-021-run-through.test.ts`, `test/land-closeout.test.ts`

**May:** `scripts/wave-cli.ts` + `src/cli/operations.ts` for `land-retry`; extracted selector script.

**Must not:** jam issue bodies / Remote Root gd, `SAFETY.*`, overnight enable, silent stash, `verify_kind: noop`, new ticket/wave status, hashing `expiresAt`, `STUCK_TICKS` default 0.

## 7. Out of scope

- RRT-028 hose-out, RRT-029 LoC research, RRT-030/031 product
- Overnight / unrestricted drain / LLM re-drain
- Softening dirty-primary into stash
- Auto-rebase onto dirty primary
- Merge/push this plan turn

## 8. Loop

1. This PLAN (forge `PLAN.md` + this file)
2. Crawmak review → `crawmak/reviews/WR-021.md` (forge-cwd; not this turn)
3. Astra or Jason stamps this file
4. Fresh IMPL: `npm test && npm run quality` → land + **push origin**

## Learn
- bite: none
- candidate: none
- promote: no

APPROVED by Jason 2026-08-17
