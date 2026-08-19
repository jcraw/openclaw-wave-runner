# Wave Runner operator runbook

**Unrestricted drain, autonomous overnight, and `SAFETY.deployPushEnabled` stay off.**
Supervised CLI (`--supervised`) and Gateway `wave_runner.start` / `tick` with `supervised: true` are the intentional real-worker path.

## Surfaces

- Plugin-owned ledger: `$OPENCLAW_STATE_DIR/wave-runner/wave.sqlite` (or the path your CLI `--db` uses)
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
when unset. Wave Runner self-work keeps `land: commit` (or the caller sets `WAVE_LAND_MODE=commit`).
**Jam done means the bytes are in the primary working tree, uncommitted.** Jason commits the jam
desk. `commit` closeout is still `landToMain` (identity, no stash, `WAVE_LAND_PUSH`).

`apply` copies the impl worktree into the primary workdir with a 3-way `git merge-file` (no
commit, HEAD unchanged). Success writes `APPLY.json` and marks the ticket `verified+applied`.
Same-file conflict leaves markers in the tree, keeps the worktree, and fails `APPLY_CONFLICT:`
— not a silent overwrite, not DONE. After verify retries are exhausted, apply-mode still copies
files in; commit-mode still does not commit red code.

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
- recurring LLM polling / overnight autonomous execution  
- production drain / worker-profile launches (`SAFETY.production*`)
- more tickets or limits than `SAFETY.supervisedMax*`
- deploy/push as a product mode (`SAFETY.deployPushEnabled`); operator may set `WAVE_LAND_PUSH=1`
- autonomous overnight / recurring LLM polling

## Agent plan-gate vs human hold (WR-023)

- **Default after PLAN** (agent-eligible, no human hold): script checks the
  plan artifact, ledger-approves, IMPL starts. Event `plan_gate_auto`. Wave
  stays `RUNNING`. No Astra. Do **not** bash-stamp `APPROVED by Astra`.
- **Human hold** (`needs_jason: true` / `eligibility: human_gated`): wave status
  `WAITING_APPROVAL`. Operator prints `OPERATOR_STOP waiting_human` and exits.
  `needs_jason: pick` (and other annotations) are **not** holds.
- **Supervised launch is ON** for explicit `--supervised` CLI / `wave-operator.sh`.
  Unrestricted drain, overnight, merge/push remain disabled.
- **Run a backlog slice:**
  `REPO=... TICKETS=A,B OUT_DIR=... ./scripts/run-backlog-wave.sh`
  No Astra session is required for agent tickets.

## Operator drain (WR-014 / WR-015)

Low-token backlog drain — **no LLM control loop**.

Scratch is pruned daily (~04:15) by `scripts/cleanup-scratch.sh --apply`
(keep 14 days / 3 newest / skip live waves). Dry-run without `--apply`.

```bash
# Daytime / overnight kick (Jason-explicit). Runs until eligible queue empty or human hold.
REPO=/path/to/game_jam \
  WR_SCRATCH=$WR_SCRATCH \
  OUT_ROOT=$WR_SCRATCH/drain-$(date +%Y%m%d) \
  MAX_PARALLEL=5 \
  bash scripts/drain-eligible.sh

# Long/overnight: same command under nohup (no wall deadline by default).
# OVERNIGHT=1 is documentary; autonomous overnight cron stays OFF.
nohup env REPO=/path/to/game_jam OVERNIGHT=1 bash scripts/drain-eligible.sh \
  > /tmp/drain-overnight.log 2>&1 &
```

Standing defaults (WR-012): `maxTokens=500000`, `maxLaunches=10`, `maxRetriesPerStage=2`,
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
4. Caps are set (`MAX_LAUNCHES`, `MAX_TOKENS`, optional `MAX_WALL_MS`).

Until a live two-ticket same-scope smoke is green: **one ticket per wave** when tickets
share `writerScope` or the same game. Same-game multi-ticket work is **serial waves**,
not one multi-ticket wave.

Do not late-edit ticket frontmatter after freeze — cancel and recreate.

`dry-run` is the preflight for the list above. `STUCK_TICKS` (default 20) stops
`wave-operator.sh` / `run-backlog-wave.sh` with `OPERATOR_STOP stuck` when a `RUNNING`
fingerprint (`wave.status` + ticket id/status/revision/result + outbox id/state +
lease key/holder/ticketId) does not change **and** no outbox is `CLAIMED` /
`LAUNCHED` / `RECONCILING`. Live in-flight work is not stuck; hung stages are
the watchdog below. `AWAITING_PLAN_GATE` is not stuck. `STUCK_TICKS=0` disables
the stop. Do not default it to 0. Lease `expiresAt` is not hashed.

Incident `BL-WR-006-20260816140320` / `PAR-board-remote_root-RRT-013-140320`:
healthy long IMPL (`IMPLEMENTING` + outbox `LAUNCHED`) was killed as stuck
because the fingerprint ignored worker liveness.

## Stage watchdog + verify capture (WR-020)

Hung PLAN/IMPL (ACP still `running` with no matching artifacts) is fail-closed
by wall clocks, not by the stuck detector:

- `WAVE_PLAN_WALL_MS` default `2700000` (45m). `0` disables.
- `WAVE_IMPL_WALL_MS` default `5400000` (90m). `0` disables.

Age is `outbox.createdAt`. Past the wall: `worker.cancel` then settle
`failed` with `stage_watchdog: <stage> hung` (WR-010 retry then applies).
Incident `PAR-prefix-MUD-MUD-037-145205`: PLAN artifacts were already on disk
(`sha256:` prefix + ACP still running) and the serial lane never settled.

Controller verify writes `WAVE_VERIFY.json` as
`{ok,command,stdout,stderr,output,exitCode,signal,timedOut,durationMs}`.
`WAVE_VERIFY_TIMEOUT_MS` default `300000`. Fail snippets are prefixed
`runner_verify:` (timeout / ENOENT / spawn) or `product_verify:` (nonzero +
captured body). Full stdout/stderr stay on disk; `ticket.result` is still
clipped to 500. Incident `PAR-board-rink_rush-RR-070-140320`: WAVE_VERIFY
kept only `Command failed: bash -lc …` and dropped the body.
