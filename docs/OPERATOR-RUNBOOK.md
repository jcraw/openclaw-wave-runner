# Wave Runner operator runbook

**Unrestricted drain, unprompted re-drain / LLM poll, and `SAFETY.deployPushEnabled` stay off.**
Supervised CLI (`--supervised`) and Gateway `wave_runner.start` / `tick` with `supervised: true` are the intentional real-worker path.

## Surfaces

- Plugin-owned ledger: `$OPENCLAW_STATE_DIR/wave-runner/wave.sqlite` (plugin Gateway path; **not** shared with CLI drain)
- Supervised CLI/drain ledger: `$WR_SCRATCH/ledgers/<sha256(canonical-repo-identity)>.sqlite` for one canonical repository (working-tree realpath; git common-dir fallback). Parallel lanes and independent drains on the same repo share it. Override with `WAVE_DB`. Explicit CLI `--db` is fixture/direct-CLI only.
- Old per-wave `$OUT_DIR/wave.sqlite` files remain inspectable by path (`sqlite3 "$OUT_DIR/wave.sqlite"`). New supervised runs do not write there. No destructive migration.
- Public JSON projection: path you pass to `project` (dashboards may read this file)
- Gateway methods: `wave_runner.*` plus preserved `wave_runner_m0.*`
- CLI (after `npm run build`):

```bash
node dist/scripts/wave-cli.js capabilities --db /path/to/wave.sqlite
node dist/scripts/wave-cli.js dry-run --wave W1 --repo /path/to/repo --tickets FX-001
node dist/scripts/wave-cli.js dry-run --wave W1 --repo /path/to/repo --tickets-json tickets.json
node dist/scripts/wave-cli.js create --wave W1 --repo /path/to/repo --tickets FX-001,FX-002
node dist/scripts/wave-cli.js create --wave W1 --repo /path/to/repo --tickets-json tickets.json
node dist/scripts/wave-cli.js start --wave W1 --simulate
node dist/scripts/wave-cli.js inspect --wave W1
node dist/scripts/wave-cli.js approve --wave W1 --ticket FX-001 --revision N
node dist/scripts/wave-cli.js pause --wave W1
node dist/scripts/wave-cli.js cancel --wave W1
node dist/scripts/wave-cli.js project --out /tmp/wave-runner/projection.json
node dist/scripts/wave-cli.js emergency-stop
node dist/scripts/wave-cli.js backup --dest /path/to/backup.sqlite
```

`--simulate` is mock-only and is not a truthful real-worker receipt.
`--supervised` (CLI) / `supervised: true` (Gateway) launches real workers under hard caps.
Land push requires explicit `WAVE_LAND_PUSH=1`; repo path never implies push.

Closeout mode is `apply` or `commit`. Ticket `land:` / `land_mode:` wins, then `WAVE_LAND_MODE`,
then `commit`. Jam drain (`drain-eligible.sh` / `run-backlog-wave.sh`) exports `WAVE_LAND_MODE=apply`
when unset. Kick **this repo** only. `PLUGIN_DIR` pointing at
`~/.openclaw/workspace/projects/agent-backlog-wave-runner` is refused (that copy
marks IMPL `DONE "verified"` and never apply-lands). Workspace wrappers exec these
scripts. `WAVE_RESULT` treats `DONE` without `applied`/`landed` in the result as
closeout debt (exit 1), not success. Wave Runner self-work keeps `land: commit` (or the caller sets `WAVE_LAND_MODE=commit`).
**Jam done means the bytes are in the primary working tree, uncommitted.** Jason commits the jam
desk. `commit` closeout is still `landToMain` (identity, no stash, `WAVE_LAND_PUSH`).

`apply` copies the impl worktree into the primary workdir as **bytes** (no commit, HEAD
unchanged). Incoming add/update/delete **overwrites** those primary paths (text and binary).
There is no `git merge-file` and no `APPLY_CONFLICT` on a dirty jam desk — ticket bytes win.
`issues/BOARD.md` is a projection (WR-024): apply never copies it; `markBoardDone` edits
primary after product paths succeed. Stamp matches `**ID open` including house
`open · worker · high` and strips leftover `not kicked`; missing row does not fail land.
`markIssueDone` walks `issues/**` and sets `status: done`
on every `ID.md` / `ID-*.md` (nested boards and leftover duplicate slugs), even if the worker
left `in_progress`. Apply copies writer-scope prefixes only (`game:`/`jam:` also get
`issues/<id>/`); extra dirty paths are skipped onto `APPLY.json.skipped` (WR-036). After verify retries are exhausted, apply-mode still
copies files in; commit-mode still does not commit red code.
Land push (`WAVE_LAND_PUSH=1`) runs `git push` with `GH_TOKEN` unset.
ACP: `sessions_spawn` does **not** take a per-call timeout (OpenClaw rejects
`timeoutSeconds`). Long jobs need host OpenClaw
`agents.defaults.timeoutSeconds` (whole agent run; OpenClaw default 48h) and
`agents.defaults.subagents.runTimeoutSeconds` (`0` = no subagent kill).
WR still fail-closes hung stages with `WAVE_PLAN_WALL_MS` / `WAVE_IMPL_WALL_MS`
(defaults 45m / 90m; `0` disables the WR watchdog). A Grok `read_file` that
starts and never completes is fail-closed sooner:
`WAVE_READ_FILE_HANG_MS` default `60000` (`0` disables). That is **only**
`read_file` — long verify bash does not trip it. Unprompted re-drain / LLM poll stay off.
Select includes `plan_review` / `planning`.
`wave-operator.sh` always writes `WAVE_RESULT.json` on terminal.

Writer and land/apply mutexes live in the **shared SQLite ledger** for that canonical repo
(`writer:<identity>:<scope>` and `land:<identity>`). Each supervised wave has a distinct
stable `WAVE_RUNNER_OPERATOR_ID` (`cli-wave:<WAVE_ID>`) so sequential CLI processes of one
wave can refresh/release, and another wave cannot impersonate it. Same-scope IMPL is
exclusive across waves; disjoint scopes may IMPL together. Land/apply closeout is exclusive
per repo: lock contention **defers** (ticket stays `VERIFYING`, writer lease kept) and the
next tick retries. Same-operator same-ticket `hold` refreshes. Durable `APPLY.json` /
`LAND.json` with `ok: true` can finish DONE even if the impl worktree is already gone.
`enqueueLand` is in-process only and is not the cross-wave authority.

Plugin `$OPENCLAW_STATE_DIR/wave-runner/wave.sqlite` stays a separate store. Mixing plugin
IMPL with CLI drain on the same primary is still split-brain; do not do that.

`scripts/cleanup-scratch.sh` prunes `$WR_SCRATCH` (dry-run default; `--apply` deletes).
It never deletes `ledgers/` (shared CLI sqlite). Cross-host / NFS locks are out of scope.

## Live failure bites (WR-020)

- `OPERATOR_STOP stuck` while an outbox is `LAUNCHED` / `CLAIMED` / `RECONCILING` → those states are live work, not stuck. Do not default `STUCK_TICKS=0` to “fix” it.
- `WAVE_VERIFY.json` that is only `Command failed: bash -lc …` dropped stdout/stderr. Keep the full record (`ok,command,stdout,stderr,exitCode,timedOut,durationMs`) and `WAVE_VERIFY_TIMEOUT_MS`.
- `terminal.hash` stored as `sha256:<hex>` vs inspect comparing raw hex → observe never settles. Normalize the prefix.

`dry-run` is the preflight. It fails closed on missing `verifyCommand` (`missing_verify`) and
returns `admitBlockers` (warnings: `human_hold`, `shared_writer_scope`, `primary_dirty_overlap`).
Drain `run-backlog-wave.sh` refuses to create/start when `primary_dirty_overlap` is present
unless `WAVE_PRIMARY_DIRTY=allow` **or** closeout mode is `apply`. There is no separate `preflight`
verb. Apply mode also skips the PLAN/IMPL dirty fail-closed; commit mode does not.

Research / spike tickets must declare a non-empty `verify` / `verify_command` (recipe:
`test -s path/to/NOTE-or-digest`). Empty string is `missing_verify` at select, dry-run, and
create. There is no `verify_kind: noop`.

Commit-mode dirty-overlap stays fail-closed (no stash). `LAND.json` includes `recovery` (overlap,
dirty, incoming, worktree, tip, operator actions). Ticket result is prefixed `CLOSEOUT_DEBT:`.
Recover by committing or stashing **unrelated** dirt, or cleaning primary then rebasing the
wave tip / `wave-cli land-retry --wave W --ticket T`. Never stash overlapping land paths.

A failed product verify rearms IMPL (existing retry cap). The next IMPL brief is FIX-shaped and
includes the verify command plus `WAVE_VERIFY.json` stdout/stderr. Blind IMPL retry without the
verify body is not enough.

Drain / lane terminal: each wave writes `WAVE_RESULT.json`. Rollup prints a per-ticket table
and exits **1** unless every kicked ticket is `DONE` with closeout ok (`land.ok` or `applied`).
`WAVE_DRAIN_BEST_EFFORT=1` keeps exit 0 after the table. There is no success-only `ALL LANES FINISHED`.

For one-off specialist work without a wave, use:

- `tools/kick_openclaw_specialist.sh` for a named OpenClaw specialist
- `tools/run_detached_builder.sh` for code: PLAN → real review → fresh IMPL → verifier

## Fixture/dev simulation

Use `dry-run`, `create`, and `start --simulate` only with disposable fixture repositories. Do not
interpret simulated artifacts as production receipts.

## Emergency stop

`wave_runner.emergency_stop` or CLI `emergency-stop` cancels every non-terminal wave and fail-closes reserved spend as `INDETERMINATE`. It does not restart the Gateway and does not launch production workers.

## Backup / restore

```bash
# backup
cp "$OPENCLAW_STATE_DIR/wave-runner/wave.sqlite" \
   "$OPENCLAW_STATE_DIR/wave-runner/backups/wave-$(date +%s).sqlite"

# restore only onto a disposable profile — never casually onto production Gateway state
cp /path/to/backup.sqlite "$OPENCLAW_STATE_DIR/wave-runner/wave.sqlite"
```

## Gates that stay closed

- unrestricted drain-everything  
- recurring LLM polling / unprompted re-drain  
- production drain / worker-profile launches (`SAFETY.production*`)
- more tickets or limits than `SAFETY.supervisedMax*`
- deploy/push as a product mode (`SAFETY.deployPushEnabled`); operator may set `WAVE_LAND_PUSH=1`

## Agent plan-gate vs human hold (WR-023 / WR-028 / WR-033 / WR-037)

**SDD (standing):** product specs in the target repo are source of truth. PLAN is a
change-set (incl. spec patches when behavior/UX changes). Crawmak/Mona **review only**
— they do not apply product changes. IMPL executes the approved plan+specs; wrongness
mid-build is **revise**, not silent redesign. Tests bind the contract.

- **Default after PLAN** (agent-eligible, no skip bit, no human hold): ticket
  `PLAN_REVIEW`, wave `AWAITING_PLAN_GATE`, one Crawmak REVIEW worker (forge cwd).
  Crawmak `reviews/<ID>.md` Verdict `approve` / `approve-with-conditions` **is**
  ledger-approve (WR-033). Leftover `APPROVED by Astra|Jason` on the plan still
  admits only when **no** Crawmak launch happened. Do **not** bash-stamp Astra.
  After Crawmak `revise`, the next hop's REVIEW must settle before the forge
  file is read again; leftover `Verdict: revise` must not `plan_review_revise_cap`
  an in-flight re-review.
- **`needs_ux: true`** (alias `ux_review: required`): after Crawmak approve-class,
  launch Mona `UX_REVIEW` (Mona workspace cwd, `agentId: mona`). Ticket stays
  `PLAN_REVIEW` until Mona `reviews/<ID>-ux.md` Verdict is approve-class
  (`ux_review_admit`). Leftover Astra/Jason stamp cannot skip Mona. Missing bit
  = skip Mona. `plan_review: skip` + `needs_ux` still requires Mona (no
  `plan_gate_auto`).
- **Skip Crawmak** only via YAML `plan_review: skip` (aliases `review: skip`,
  `review_skip: true`, `jason_skip: true`): PLAN artifact check → ledger
  `APPROVED` + `plan_gate_auto` → IMPL when **not** `needs_ux`. Wave stays `RUNNING`.
- **Hybrid / `plan_worker: codex`:** Codex ACP PLAN (`agentId: "codex"`,
  `runtime: "acp"`), Grok IMPL. CLI fallback refuses Codex PLAN. OpenClaw
  `acp.allowedAgents` must include `codex` and acpx `agents.codex` must exist;
  WR does not edit `~/.openclaw/openclaw.json`. First hybrid wave after land
  fails closed until that allowlist exists — that is success vs silent Grok.
- **Human hold** (`needs_jason: true` / `eligibility: human_gated`): wave status
  `WAITING_APPROVAL`. Operator prints `OPERATOR_STOP waiting_human` and exits.
  `needs_jason: pick` (and other annotations) are **not** holds. No Crawmak, no Mona.
- **Supervised launch is ON** for explicit `--supervised` CLI / `wave-operator.sh`.
  Unrestricted drain, unprompted re-drain, merge/push remain disabled.
- **Run a backlog slice:**
  `REPO=... TICKETS=A,B OUT_DIR=... ./scripts/run-backlog-wave.sh`
  No Astra session is required for agent tickets.

## Operator drain (WR-014 / WR-034)

Low-token backlog drain — **no LLM control loop**. One kick; clock time is not a mode.

A drain runs until the eligible queue is empty or a real stop: stage watchdogs
(`WAVE_PLAN_WALL_MS` 45m / `WAVE_IMPL_WALL_MS` 90m; `0` disables), token/launch
caps (`MAX_TOKENS` / `MAX_LAUNCHES`), stuck detector, human hold, emergency-stop.
Optional `WAVE_WALL_S` is a shell timeout in seconds (`0` = none, the default).
It is not a time of day.

Scratch is pruned daily (~04:15) by `scripts/cleanup-scratch.sh --apply`
(keep 14 days / 3 newest / skip live waves). Dry-run without `--apply`.

```bash
# Operator kick. Runs until eligible queue empty or a real stop.
REPO=/path/to/game_jam \
  WR_SCRATCH=$WR_SCRATCH \
  OUT_ROOT=$WR_SCRATCH/drain-$(date +%Y%m%d) \
  MAX_PARALLEL=5 \
  bash scripts/drain-eligible.sh

# Optional desk timeout (seconds), not a clock-time mode:
# WAVE_WALL_S=3600 bash scripts/drain-eligible.sh

# Unattended: same command under nohup. Unprompted re-drain / LLM poll stay OFF.
nohup env REPO=/path/to/game_jam bash scripts/drain-eligible.sh \
  > /tmp/drain.log 2>&1 &
```

Standing defaults (WR-039): `maxTokens=500000`, `maxLaunches=48` (supervised; 8 tickets × PLAN+REVIEW+UX+IMPL plus retry spare). `maxRetriesPerStage=2`,
`maxWallTimeMs=0`, lease TTL 2h, ACP concurrent sessions 5 (OpenClaw config).
Land-on-done (WR-013 / WR-017): verified IMPL lands to `main` before ticket DONE.
Land commits use the primary repo `user.name` / `user.email` (or both `WAVE_LAND_NAME` and
`WAVE_LAND_EMAIL`). The runner never invents `wave-runner@local`. Successful land removes
the impl worktree; durable proof is `tmp/wave-runner/<wave>/<ticket>/LAND.json`.
Push still requires explicit `WAVE_LAND_PUSH=1`.

## Kick hygiene (WR-019)

Incident `BL-RR-070-068-20260816104319` (RR-070 + RR-068, writer scope `game:rink_rush`):
IMPL settled `missing_verify`, the writer lease stayed held, the sibling sat `APPROVED`
forever, and the operator burned 100+ no-op ticks while the wave stayed `RUNNING`.

Before `create` / `start`:

1. Every ticket has `verify` / `verify_command` in frontmatter (explicit `"true"` is a fixture only).
2. `agent_eligible` is set when the ticket should auto-continue after PLAN.
3. No stale writer lease on the same `writerScope` / game.
4. Caps are set (`MAX_LAUNCHES`, `MAX_TOKENS`, optional `MAX_WALL_MS`). Happy-path hops
   are PLAN + Crawmak REVIEW (unless `plan_review: skip`) + Mona UX (if `needs_ux`) + IMPL.
   `dry-run` emits `hops_exceed_max_launches` when that sum is above `maxLaunches`;
   `run-backlog-wave.sh` preflight-fails. Leave `MAX_LAUNCHES` unset (48).
   Idle `max_launches` becomes `BUDGET_STOPPED`; it must not throw out of `tick`.

Same-scope IMPL is serial (`repoConcurrency=1`). Multi-ticket same-game waves are allowed
when hops fit the cap. Hybrid is Codex ACP PLAN + Grok IMPL. The 01:30
`ACP_TURN_FAILED: Internal error` was **@zed-industries/codex-acp 0.16.0** rejecting
`gpt-5.6-sol` (embedded client, not PATH `codex`). WR spawn pins `gpt-5.5` +
`thinking=off`. Do not stamp tickets grok to “fix” that. `codex_plan_unsafe` on
dry-run is a warning, not a drain skip. `WAVE_CODEX_MODEL` overrides the pin.
Do not set `MAX_LAUNCHES=10` on kick wrappers — leave it unset (48).
Apply-on-exhausted is IMPL-only; a PLAN fail must not copy the worktree or mark BOARD done.

Do not late-edit ticket frontmatter after freeze — cancel and recreate.

`dry-run` is the preflight for the list above. `STUCK_TICKS` (default 20) stops
`wave-operator.sh` / `run-backlog-wave.sh` with `OPERATOR_STOP stuck` when a `RUNNING`
fingerprint (`wave.status` + ticket id/status/revision/result + outbox id/state +
lease key/holder/ticketId) does not change **and** there is no live work: outbox
`CLAIMED` / `LAUNCHED` / `RECONCILING`, **or** a `VERIFYING` ticket awaiting
land/apply closeout. Live in-flight work and closeout waits are not stuck; hung
stages are the watchdog below. `AWAITING_PLAN_GATE` is not stuck. `STUCK_TICKS=0`
disables the stop. Do not default it to 0. Lease `expiresAt` is not hashed.

Incident `BL-WR-006-20260816140320` / `PAR-board-remote_root-RRT-013-140320`:
healthy long IMPL (`IMPLEMENTING` + outbox `LAUNCHED`) was killed as stuck
because the fingerprint ignored worker liveness.

## Stage watchdog + verify capture (WR-020)

Hung PLAN/IMPL (ACP still `running` with no matching artifacts) is fail-closed
by wall clocks, not by the stuck detector:

- `WAVE_PLAN_WALL_MS` default `2700000` (45m). `0` disables.
- `WAVE_IMPL_WALL_MS` default `5400000` (90m). `0` disables.
- `WAVE_READ_FILE_HANG_MS` default `60000` (60s). `0` disables. Only in-flight
  Grok `read_file` (no matching `tool_completed`); `run_terminal_command` /
  `image_gen` / verify are not this timer.

Age is `outbox.createdAt`. Past the wall: `worker.cancel` then settle
`failed` with `stage_watchdog: <stage> hung` (WR-010 retry then applies).
A Grok session with `tool_started read_file` and no matching complete past
`WAVE_READ_FILE_HANG_MS` settles `stage_watchdog: read_file hung` the same way.
Incident `PAR-prefix-MUD-MUD-037-145205`: PLAN artifacts were already on disk
(`sha256:` prefix + ACP still running) and the serial lane never settled.

Controller verify writes `WAVE_VERIFY.json` as
`{ok,command,stdout,stderr,output,exitCode,signal,timedOut,durationMs}`.
`WAVE_VERIFY_TIMEOUT_MS` default `300000`. Fail snippets are prefixed
`runner_verify:` (timeout / ENOENT / spawn) or `product_verify:` (nonzero +
captured body). Full stdout/stderr stay on disk; `ticket.result` is still
clipped to 500. Incident `PAR-board-rink_rush-RR-070-140320`: WAVE_VERIFY
kept only `Command failed: bash -lc …` and dropped the body.
