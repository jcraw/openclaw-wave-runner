# WR-022 plan — apply closeout + verify FIX

**Ticket:** `issues/WR-022-apply-closeout-and-verify-fix.md`  
**Forge mirror:** `crawmak/tmp/workers/WR-022/PLAN.md`  
**Verify:** `npm test && npm run quality`  
**This ticket’s closeout:** `land: commit` (do not apply WR onto a dirty WR tree)  
**Author:** `JCraw <4335668+jcraw@users.noreply.github.com>` + push `origin`

PLAN ONLY. No product jam. No SAFETY flips.

## 1. Goal

Worktrees stay for IMPL isolation. **Jam done = files in the primary working tree, uncommitted.** Jason commits later.

**Commit-land stays** when Jason directs it (WR, `land: commit`, `WAVE_LAND_MODE=commit`). That path is today’s `landToMain`.

Failed path-verify becomes a FIX pass that can see the verify output. After retries, apply-mode still puts the code in the desk. Commit-mode never commits red code.

## 2. Findings

| # | Fact | Gap |
|---|---|---|
| F1 | Jason: one `game_jam` folder; dirty until he commits; other agents in parallel. Worktree-only ≠ done. | WR-013 defined done as a **main commit**. WR-017/021 refuse when that commit would overlap dirty paths. |
| F2 | “Land” is not a merge conflict. Git can merge. Runner refuses uncommitted overlap so it won’t commit on top of a desk. | Correct for commit-land. Wrong if closeout is “write files into the desk.” |
| F3 | WR-021 `failClosedIfPrimaryDirty` + drain refuse spend money before a land that will fail. | Blocks jam waves that could apply. |
| F4 | `product_verify` rearms IMPL (maxRetriesPerStage=2). Brief is still `IMPL <id> <title>`. RR-073 burned retries (parse + 30s headless + tier2). | No FIX brief, no verify body. |
| F5 | Pocket Dice `commit` closeout on a **clean** fixture went WAVE_OK. Proves controller; does not prove jam desk. | |

## 3. Decisions

| # | Pick |
|---|---|
| D1 | Modes: `apply` \| `commit`. `commit` = `executeLandToMain` unchanged (identity, `WAVE_LAND_PUSH`, no stash, `land-retry`, `CLOSEOUT_DEBT`). |
| D2 | Resolve: ticket `land`/`land_mode` → env `WAVE_LAND_MODE` → **default `commit`**. Do not path-match repo names (WR-018). |
| D3 | `scripts/drain-eligible.sh` and `run-backlog-wave.sh`: if `WAVE_LAND_MODE` unset, export **`apply`**. WR self-work: ticket `land: commit` and/or caller sets `WAVE_LAND_MODE=commit`. Crawmak `registry/repos.yaml`: optional `land_mode`; `kick.sh` exports it when env unset. |
| D4 | **apply:** incoming paths = `git diff --name-only <baseSha> <tip>` on the impl worktree. For each path, write **workdir only** (no `git commit`, do not require clean index). 3-way: base blob at `baseSha`, ours = primary workdir (or HEAD if clean), theirs = tip. `git merge-file`. Conflict markers stay in the file. |
| D5 | Apply success, no conflicts → ticket **DONE**, `result=verified+applied`, `APPLY.json` `{ok,paths,mode:"apply"}`. Board/ticket md edited **in workdir only** (reuse markBoardDone/markIssueDone, drop `commitWithIdentity`). Remove impl worktree after ok apply. |
| D6 | Apply conflicts → files still in primary (including markers). Ticket **FAILED** `APPLY_CONFLICT:`. `APPLY.json` ok:false + conflict paths. Keep worktree. No stash. |
| D7 | Apply mode: **skip** `failClosedIfPrimaryDirty` and drain `primary_dirty_overlap` refuse. dry-run may still *warn*. Commit mode: WR-021 hard preflight stays. |
| D8 | Verify fail + retries left → requeue IMPL (existing state). Copy `WAVE_VERIFY.json` into the next attempt dir. ACP IMPL brief if attempt>1 or classify present: **FIX** header, verify command, classify, stdout/stderr (clip ~8k). Do **not** add `StageName` `FIX` this slice. |
| D9 | Retries exhausted + apply mode + impl worktree exists → **apply anyway**, ticket **FAILED** `product_verify` (or last reason) + `applied`. Commit mode: no `landToMain` on red verify (today). |
| D10 | `runner_verify` (timeout/ENOENT): same retry+FIX brief; do not apply until a product verify actually ran, unless retries exhausted (then apply-mode still copy so work is not stranded). |
| D11 | Drain `WAVE_RESULT` / `land.ok`: apply success counts as closeout ok (rename conceptually to closeout.ok in result writer if cheap; else `landOk` true on apply). Inspect text must say `applied`, not `landed`, in apply mode. |
| D12 | Extract apply helper so `land-git.ts` / `land-closeout.ts` stay under the WR-021 size cap. No silent overwrite of a dirty same-file without merge-file. |

## 4. Approach

### P0.1 — mode resolver
Pure `resolveCloseoutMode({ ticketLand, env })`. Tests: ticket wins, env wins, default commit.

### P0.2 — `applyToWorkdir` adapter
New `src/adapters/apply-workdir.ts` + `WorkspaceAdapter.applyToWorkdir`. Proof `APPLY.json` next to today’s LAND proof path shape (`tmp/wave-runner/<wave>/<ticket>/APPLY.json`). Fixture git repo: dirty unrelated file + incoming file → apply, `rev-parse HEAD` unchanged, workdir has incoming. Same-file edit both sides → conflict fixture. `mock-workspace` implements no-op/in-memory.

### P0.3 — `finalizeImplLand` branches
After verify green: `commit` → `landToMain`; `apply` → `applyToWorkdir`. DONE only if proof ok. Failed apply → FAILED + APPLY.json, not pretend DONE.

### P0.4 — admit / drain
`failClosedIfPrimaryDirty` and `run-backlog-wave.sh` overlap refuse honor mode. Apply → no refuse. Commit → current.

### P0.5 — FIX brief
`intentFromOutbox` / `stageBrief`: if prior verify record exists, FIX prompt. `settlement` already rearms IMPL. Tests: fake worker launch prompt includes `product_verify` snippet.

### P0.6 — exhaust apply
On last failed IMPL settle in apply mode, call `applyToWorkdir` before FAILED. Assert HEAD unchanged + files present + not DONE.

### P1 — runbook
`docs/OPERATOR-RUNBOOK.md`: jam desk = apply; WR = commit; Jason is jam commit gate; conflict = files in tree, ticket FAILED.

## 5. Tests (`test/wr-022-apply-closeout.test.ts` + extend verify/land)

| Contract | Assert |
|---|---|
| apply disjoint dirty | HEAD same; incoming in workdir; DONE |
| apply 3-way clean | both edits kept; DONE |
| apply conflict | markers; FAILED `APPLY_CONFLICT`; worktree kept |
| commit unchanged | existing land-on-done / no-stash / push-only-if-`WAVE_LAND_PUSH` |
| apply skips dirty admit | dirty jam prefix + apply → PLAN/IMPL queued |
| commit still admits-fail | dirty + commit + no allow → no launch |
| FIX brief | 2nd IMPL prompt contains verify command + body |
| exhaust apply | red verify + apply mode → files in tree, FAILED, not landed commit |
| drain env | unset `WAVE_LAND_MODE` in drain-eligible → apply |
| ticket override | `land: commit` beats drain default |

## 6. Touched set

**Must:** `src/domain/` closeout-mode helper, `src/adapters/apply-workdir.ts`, `src/adapters/workspace.ts`, `src/adapters/mock-workspace.ts`, `src/adapters/ports.ts` / `src/core/ports.ts`, `src/core/land-closeout.ts`, `src/core/primary-dirty-gate.ts`, `src/core/settlement.ts`, `src/core/launch.ts` or `acp-worker.ts` brief, `src/adapters/stage-artifacts.ts` if needed, `scripts/drain-eligible.sh`, `scripts/run-backlog-wave.sh`, `docs/OPERATOR-RUNBOOK.md`, this plan, ticket, `test/wr-022-apply-closeout.test.ts`

**May:** crawmak `scripts/kick.sh` + `registry/repos.yaml` `land_mode`; `scripts/wave-result.ts` closeout wording

**Must not:** jam product trees, `SAFETY.*`, overnight on, silent stash, path-based push, inventing Astra, dropping `land: commit` on this ticket

## 7. Out of scope

- Auto-commit Jason’s jam desk
- Replacing worktrees during IMPL
- Dedicated `FIX` stage enum
- Softening commit-mode dirty fail-closed
- Overnight drain / unrestricted drain

## 8. Loop

1. This PLAN + ticket (this turn). Stop.
2. Crawmak review → `crawmak/reviews/WR-022.md`
3. Astra or Jason stamps **this file**
4. Fresh IMPL: `npm test && npm run quality` → **commit-land** WR `main` + push

## Learn
- bite: none
- candidate: jam “done” = workdir bytes, not a git commit — do not reuse commit-land as that word
- promote: no
