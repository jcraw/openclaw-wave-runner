# WR-052 — Grok REVIEW grok-cli + reviews-file admit (PLAN)

**Ticket:** WR-052 · **Repo:** openclaw-wave-runner
**Verify:** `npm test && npm run quality`
**Land:** commit + push origin
**This turn:** IMPL this change-set (Jason 2026-09-08 ordered; Crawmak review in `crawmak/reviews/WR-052.md`)

## Goal / AC

Grok REVIEW hop launches a forge-cwd grok-cli worker (`--phase reviewing`) and settles when `crawmak/reviews/<ID>.md` is admit-ready. Empty `WAVE_RUNNER_LAUNCHER` still gets jam `run_detached_builder.sh` when that binary exists.

## Live vs contract-only

| Live this land | Later |
|---|---|
| grok-cli REVIEW phase/brief/cwd; inspect on review file; default launcher in shell | Mona UX inspect-on-file; OpenClaw agent named `grok`; kick.sh deletion |
| Runbook one-liner: N=1 is WR | CA-018 Astra copy (crawmak + OpenClaw workspace) |

## Spec paths (patch this land)

### `src/adapters/grok-cli.ts` — live

- `REVIEW` → jam `--phase reviewing`, brief `REVIEW_BRIEF.md` from `stageBrief()`, `--log-basename grok-review`, `--repo` = `intent.worktree` (forge).
- Receipt `cwd` = that worktree.
- Still refuse `UX_REVIEW` and `agentId === "codex"`.
- PLAN/IMPL argv unchanged.

### `src/adapters/stage-artifacts.ts` — live

- Shared REVIEW inspect: matching `terminal.json` **or** `checkPlanReview({ forgeRoot: receipt.cwd, ticketId })`.ok → `succeeded` (verdict may be `revise`).
- Missing file + not live → keep today’s unknown (watchdog). Theater (`checkPlanReview` not ok with a file) → `failed` `review_theater`.
- `inspectReceiptArtifacts` passes `receipt.cwd` as forgeRoot for REVIEW.

### `scripts/supervisor-health.sh` + three callers — live

- `resolve_grok_launcher`: if `WAVE_RUNNER_LAUNCHER` empty, use sibling `../game_jam/tools/run_detached_builder.sh` when executable (`DEFAULT_GROK_LAUNCHER` override for tests).
- Call from `wave-supervisor.sh`, `run-backlog-wave.sh`, `wave-operator.sh` (source health in operator).

### `docs/OPERATOR-RUNBOOK.md` — live

- Named id list includes **one** ticket. Operator path is `run-backlog-wave.sh`, not crawmak `kick.sh`.
- Grok REVIEW = grok-cli + `reviews/<ID>.md` (terminal.json optional).

## Read first

| Path | Change |
|---|---|
| `src/adapters/grok-cli.ts` | REVIEW phase/brief/cwd/receipt |
| `src/adapters/stage-artifacts.ts` | inspect REVIEW file |
| `src/adapters/stage-briefs.ts` | cite only (already asks reviews + terminal) |
| `src/core/plan-review.ts` | cite `checkPlanReview` |
| `scripts/supervisor-health.sh` | `resolve_grok_launcher` |
| `scripts/wave-supervisor.sh` | call resolver |
| `scripts/run-backlog-wave.sh` | default export via resolver |
| `scripts/wave-operator.sh` | source health + resolver |
| `docs/OPERATOR-RUNBOOK.md` | N=1 + REVIEW admit |
| `test/wr-052-grok-review-cli.test.ts` | new |

## Live

- `launchCwd(REVIEW)` already forge. `RoutedProductWorker` already grok-cli when `agents.list` has no `grok`.
- Jam `_phase_artifact_ok`: non-planning has no PLAN.md gate (`reviewing` is fine).
- WR-038: do not skip `queueMissingPlanReviews` because a review file exists.

## Do not open

`src/core/plan-review-settle.ts` skip-launch-on-file. Mona. `openclaw.json`. Jam product. crawmak `kick.sh --phase review`. Live RRT/MC-006 waves. WR-048/049/050 untracked.

## Approach

1. Inspect helper + grok-cli REVIEW argv + receipt.cwd.
2. Default launcher in sourced health; three shells call it.
3. Tests: launch captures `--phase reviewing` and forge `--repo`; inspect succeeds on forge `reviews/T.md` without terminal; theater fails; PLAN argv still `planning`.
4. Runbook two sentences.
5. `npm test && npm run quality`; commit-land; push.

## Out of scope

CA-018 dual-path copy. Deleting `kick.sh`. Respawn live supervisor.

## Learn

- bite: none
- candidate: empty `WAVE_RUNNER_LAUNCHER` + REVIEW → grok-cli `reviewing` + inspect `reviews/<ID>.md` — do not ACP agent `grok`, do not jam `planning`
- promote: no
