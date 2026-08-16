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
Land-on-done (WR-013 / WR-017): verified IMPL lands to `main` before ticket DONE.
Land commits use the primary repo `user.name` / `user.email` (or both `WAVE_LAND_NAME` and
`WAVE_LAND_EMAIL`). The runner never invents `wave-runner@local`. Successful land removes
the impl worktree; durable proof is `tmp/wave-runner/<wave>/<ticket>/LAND.json`.
Push still requires explicit `WAVE_LAND_PUSH=1`.
