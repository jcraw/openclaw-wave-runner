# Wave Runner operator runbook

**Production backlog drain is disabled.** Overnight remains an explicit operator human gate.

## Surfaces

- Plugin-owned ledger: `$OPENCLAW_STATE_DIR/wave-runner/wave.sqlite` (or the path your CLI `--db` uses)
- Public JSON projection: path you pass to `project` (dashboards may read this file)
- Gateway methods: `wave_runner.*` plus preserved `wave_runner_m0.*`
- CLI (after `npm run build`):

```bash
node dist/scripts/wave-cli.js capabilities --db /path/to/wave.sqlite
node dist/scripts/wave-cli.js dry-run --wave W1 --repo /path/to/repo --tickets FX-001
node dist/scripts/wave-cli.js create --wave W1 --repo /path/to/repo --tickets FX-001,FX-002
node dist/scripts/wave-cli.js start --wave W1 --simulate
node dist/scripts/wave-cli.js inspect --wave W1
node dist/scripts/wave-cli.js approve --wave W1 --ticket FX-001 --revision N
node dist/scripts/wave-cli.js pause --wave W1
node dist/scripts/wave-cli.js cancel --wave W1
node dist/scripts/wave-cli.js project --out /tmp/wave-runner/projection.json
node dist/scripts/wave-cli.js emergency-stop
node dist/scripts/wave-cli.js backup --dest /path/to/backup.sqlite
```

Supervised bounded run (real worker adapter; still not production drain):

```bash
node dist/scripts/wave-cli.js create --wave W1 --repo /path/to/repo --tickets FX-001,FX-002 \
  --supervised --worktree-root /tmp/wave-worktrees \
  --max-launches 4 --max-tokens 48000 --max-wall-ms 1200000
node dist/scripts/wave-cli.js start --wave W1 --repo /path/to/repo --supervised --worktree-root /tmp/wave-worktrees \
  --artifact-root /tmp/wave-artifacts
node dist/scripts/wave-cli.js tick --wave W1 --repo /path/to/repo --supervised --worktree-root /tmp/wave-worktrees \
  --artifact-root /tmp/wave-artifacts
```

`start` / `tick` require `--supervised` or `--simulate`. Product workers go through OpenClaw ACP when the spawn port is injected; the plugin fails closed if that port is missing. `--launcher` is compatibility fallback only. Every real-worker tick is an **explicit operator action** — there is no recurring LLM poll. Supervised manifests accept only an immutable **1–3** ticket list and hard-cap launches / tokens / wall time. `--simulate` is mock-only and is not a truthful real-worker receipt.

## Bounded wave (replaces “clear the backlog”)

1. Choose an explicit ticket list. Never “drain everything”.
2. `dry-run` then `create` then `start`.
3. PLAN writes wave artifacts. Approve (or rely on safe-policy / docs-only modes when configured).
4. IMPL uses an isolated worktree. Verification runs there.
5. Inspect proof artifacts. Merge/push is a separate human policy and is **off** by default.

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
- production worker launches  
- more than 3 supervised tickets or limits above supervised caps  
- deploy/push from the runner  
- overnight enablement without an explicit operator policy change in code + process  
