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

`dry-run` is the preflight. It fails closed on missing `verifyCommand` (`missing_verify`) and
returns `admitBlockers` (warnings: `human_hold`, `shared_writer_scope`). There is no separate
`preflight` verb.

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

## Agent plan-gate vs human hold (WR-008)

- **Default after PLAN** (agent-eligible tickets): wave status `AWAITING_PLAN_GATE`.
  Operator loop **stays running** and waits. Astra reads `PLAN.md` and runs
  `wave-operator.sh approve <ticket> <revision>`. Ledger event `plan_gate_wake`
  is the durable receipt. Do **not** bash-stamp `APPROVED`.
- **Human hold** (`needs_jason` / `eligibility: human_gated`): wave status
  `WAITING_APPROVAL`. Operator prints `OPERATOR_STOP waiting_human` and exits.
- **Supervised launch is ON** for explicit `--supervised` CLI / `wave-operator.sh`.
  Unrestricted drain, overnight, merge/push remain disabled.
- **Run a backlog slice:**
  `REPO=... TICKETS=A,B OUT_DIR=... ./scripts/run-backlog-wave.sh`
  Keep an Astra session watching plan-gate wakes until the wave completes.

## Operator drain (WR-014 / WR-015)

Low-token backlog drain — **no LLM control loop**.

```bash
# Daytime / overnight kick (Jason-explicit). Runs until eligible queue empty or human hold.
REPO=/path/to/game_jam \
  OUT_ROOT=~/.openclaw/workspace/projects/agent-backlog-wave-runner/tmp/drain-$(date +%Y%m%d) \
  MAX_PARALLEL=5 \
  bash scripts/drain-eligible.sh

# Long/overnight: same command under nohup (no wall deadline by default).
# OVERNIGHT=1 is documentary; autonomous overnight cron stays OFF.
nohup env REPO=/path/to/game_jam OVERNIGHT=1 bash scripts/drain-eligible.sh \
  > /tmp/drain-overnight.log 2>&1 &
```

Standing defaults (WR-012): `maxTokens=500000`, `maxLaunches=10`, `maxRetriesPerStage=2`,
`maxWallTimeMs=0`, lease TTL 2h, ACP concurrent sessions 5 (OpenClaw config).
Land-on-done (WR-013): verified IMPL lands to `main` before ticket DONE.

## Kick hygiene (WR-019)

Incident `BL-RR-070-068-20260816104319` (RR-070 + RR-068, writer scope `game:rink_rush`):
IMPL settled `missing_verify`, the writer lease stayed held, the sibling sat `APPROVED`
forever, and the operator burned 100+ no-op ticks while the wave stayed `RUNNING`.

Before `create` / `start`:

1. Every ticket has `verify` / `verify_command` in frontmatter (explicit `"true"` is a fixture only).
2. `agent_eligible` is set when the ticket should take the agent plan-gate.
3. No stale writer lease on the same `writerScope` / game.
4. Caps are set (`MAX_LAUNCHES`, `MAX_TOKENS`, optional `MAX_WALL_MS`).

Until a live two-ticket same-scope smoke is green: **one ticket per wave** when tickets
share `writerScope` or the same game. Same-game multi-ticket work is **serial waves**,
not one multi-ticket wave.

Do not late-edit ticket frontmatter after freeze — cancel and recreate.

`dry-run` is the preflight for the list above. `STUCK_TICKS` (default 20) stops
`wave-operator.sh` / `run-backlog-wave.sh` with `OPERATOR_STOP stuck` when a `RUNNING`
fingerprint (`wave.status` + ticket id/status/revision/result + outbox id/state +
lease key/holder/ticketId) does not change. `AWAITING_PLAN_GATE` is not stuck.
`STUCK_TICKS=0` disables the stop.
