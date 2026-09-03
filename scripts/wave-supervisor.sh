#!/usr/bin/env bash
# One no-LLM tick loop for every live slice in $WR_SCRATCH/ledgers.
# Spawned by run-backlog-wave.sh; do not start a second copy.
set -euo pipefail
WR="${WR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
WR_SCRATCH="${WR_SCRATCH:-/run/media/j/866e11e8-6c31-4c0c-a07c-704845033900/ai/wave-runner}"
EXPECTED_UUID="866e11e8-6c31-4c0c-a07c-704845033900"
_scratch_uuid="$(findmnt -n -o UUID -T "$WR_SCRATCH" 2>/dev/null || true)"
if [[ "$_scratch_uuid" != "$EXPECTED_UUID" ]]; then
  echo "error: Wave Runner scratch is not on the 7.3T data disk (unmounted or wrong UUID): $WR_SCRATCH" >&2
  exit 1
fi
PLUGIN_DIR="${PLUGIN_DIR:-$WR}"
CLI_JS="${CLI_JS:-$PLUGIN_DIR/dist/scripts/wave-cli.js}"
if [[ ! -f "$CLI_JS" ]]; then
  echo "error: missing $CLI_JS — run npm run build in $PLUGIN_DIR" >&2
  exit 2
fi
TICK_SLEEP="${TICK_SLEEP:-20}"
IDLE_S="${WAVE_IDLE_EXIT_S:-1800}"
PIDFILE="${WAVE_SUPERVISOR_PIDFILE:-$WR_SCRATCH/supervisor.pid}"
echo $$ >"$PIDFILE"
trap 'rm -f "$PIDFILE"' EXIT
idle_since="$(date +%s)"
LEDGER_DIR="$WR_SCRATCH/ledgers"
mkdir -p "$LEDGER_DIR" "$WR_SCRATCH/supervisor-worktrees" "$WR_SCRATCH/supervisor-artifacts"

peek_repo() {
  node --input-type=module - "$1" <<'JS'
import { DatabaseSync } from "node:sqlite";
const dead = new Set(["COMPLETED", "FAILED", "CANCELLED", "BUDGET_STOPPED", "BLOCKED"]);
const db = new DatabaseSync(process.argv[1], { readOnly: true });
const rows = db.prepare("SELECT repo_path, status FROM waves").all();
const live = rows.find((r) => !dead.has(String(r.status)));
if (live?.repo_path) process.stdout.write(String(live.repo_path));
JS
}

while true; do
  live=0
  shopt -s nullglob
  for db in "$LEDGER_DIR"/*.sqlite; do
    base="$(basename "$db")"
    [[ "$base" == acp-* ]] && continue
    repo="$(peek_repo "$db" || true)"
    if [[ -z "$repo" ]]; then
      continue
    fi
    live=1
    set +e
    node "$CLI_JS" tick-all --db "$db" --repo "$repo" --supervised \
      --worktree-root "$WR_SCRATCH/supervisor-worktrees" \
      --artifact-root "$WR_SCRATCH/supervisor-artifacts" \
      >/dev/null
    set -e
  done
  now="$(date +%s)"
  if [[ "$live" -eq 0 ]]; then
    if (( now - idle_since >= IDLE_S )); then
      echo "supervisor idle exit"
      exit 0
    fi
  else
    idle_since="$now"
  fi
  sleep "$TICK_SLEEP"
done
