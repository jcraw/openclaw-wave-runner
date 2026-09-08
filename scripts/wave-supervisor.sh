#!/usr/bin/env bash
# One no-LLM tick loop for every live slice in $WR_SCRATCH/ledgers.
# Spawned by run-backlog-wave.sh; do not start a second copy.
set -euo pipefail
WR="${WR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
WR_SCRATCH="${WR_SCRATCH:-/run/media/j/866e11e8-6c31-4c0c-a07c-704845033900/ai/wave-runner}"
EXPECTED_UUID="866e11e8-6c31-4c0c-a07c-704845033900"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=supervisor-health.sh
source "$SCRIPT_DIR/supervisor-health.sh"
if [[ "${WAVE_SKIP_SCRATCH_UUID:-}" != "1" ]]; then
  _scratch_uuid="$(findmnt -n -o UUID -T "$WR_SCRATCH" 2>/dev/null || true)"
  if [[ "$_scratch_uuid" != "$EXPECTED_UUID" ]]; then
    echo "error: Wave Runner scratch is not on the 7.3T data disk (unmounted or wrong UUID): $WR_SCRATCH" >&2
    exit 1
  fi
fi
if ! resolve_run_operator_id; then
  exit 1
fi
export WAVE_LAND_MODE="${WAVE_LAND_MODE:-apply}"
PLUGIN_DIR="${PLUGIN_DIR:-$WR}"
CLI_JS="${CLI_JS:-$PLUGIN_DIR/dist/scripts/wave-cli.js}"
if [[ ! -f "$CLI_JS" ]]; then
  echo "error: missing $CLI_JS — run npm run build in $PLUGIN_DIR" >&2
  exit 2
fi
TICK_SLEEP="${TICK_SLEEP:-20}"
IDLE_S="${WAVE_IDLE_EXIT_S:-1800}"
STUCK_TICKS="${STUCK_TICKS:-20}"
TARGET_WAVE="${WAVE_SUPERVISOR_WAVE_ID:-}"
TARGET_REPO="${WAVE_SUPERVISOR_REPO:-}"
PIDFILE="${WAVE_SUPERVISOR_PIDFILE:-$WR_SCRATCH/supervisor.pid}"
echo $$ >"$PIDFILE"
trap 'rm -f "$PIDFILE"' EXIT
idle_since="$(date +%s)"
LEDGER_DIR="$WR_SCRATCH/ledgers"
mkdir -p "$LEDGER_DIR" "$WR_SCRATCH/supervisor-worktrees" "$WR_SCRATCH/supervisor-artifacts"
write_supervisor_heartbeat 0 "" ""
ALL_FAIL_N=0
declare -A TICK_FAIL_BY_SCOPE=()
STUCK_N=0
PREV_FP=""

list_live_repo() {
  if [[ -n "$TARGET_WAVE" && -n "$TARGET_REPO" ]]; then
    status_json="$(node "$CLI_JS" inspect --db "$1" --repo "$TARGET_REPO" --wave "$TARGET_WAVE" 2>/dev/null || true)"
    status="$(python3 -c 'import json,sys; d=json.load(sys.stdin); print((d.get("wave") or {}).get("status") or "")' <<<"$status_json" 2>/dev/null || true)"
    case "$status" in
      COMPLETED|FAILED|CANCELLED|BUDGET_STOPPED|BLOCKED|"") return 0 ;;
      *) printf '%s' "$TARGET_REPO"; return 0 ;;
    esac
  fi
  node "$CLI_JS" list-live --db "$1" 2>/dev/null || true
}

fingerprint_views() {
  python3 - "$1" <<'PY'
import hashlib, json, sys
raw = open(sys.argv[1], encoding="utf8").read().strip() or "{}"
d = json.loads(raw)
views = d.get("views") or []
payload = []
for v in views:
    w = v.get("wave") or {}
    payload.append({
        "id": w.get("waveId") or "",
        "status": w.get("status") or "",
        "tickets": sorted([
            {"id": t.get("ticketId"), "status": t.get("status"),
             "revision": t.get("revision"), "result": t.get("result") or ""}
            for t in (v.get("tickets") or [])
        ], key=lambda x: str(x["id"] or "")),
        "outbox": sorted([
            {"id": o.get("outboxId"), "state": o.get("state")}
            for o in (v.get("outbox") or [])
        ], key=lambda x: str(x["id"] or "")),
        "leases": sorted([
            {"key": l.get("resourceKey"), "holder": l.get("holder"),
             "ticketId": l.get("ticketId") or ""}
            for l in (v.get("leases") or [])
        ], key=lambda x: str(x["key"] or "")),
    })
payload.sort(key=lambda x: x["id"])
print(hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest())
PY
}

has_live_work_views() {
  python3 - "$1" <<'PY'
import json, sys
d = json.loads(open(sys.argv[1], encoding="utf8").read() or "{}")
live = {"PENDING", "CLAIMED", "LAUNCHED", "RECONCILING"}
for v in d.get("views") or []:
    if any((o.get("state") or "") in live for o in (v.get("outbox") or [])):
        print("1"); raise SystemExit
    if any((t.get("status") or "") == "VERIFYING" for t in (v.get("tickets") or [])):
        print("1"); raise SystemExit
print("0")
PY
}

all_running_views() {
  python3 - "$1" <<'PY'
import json, sys
d = json.loads(open(sys.argv[1], encoding="utf8").read() or "{}")
views = d.get("views") or []
if not views:
    print("0"); raise SystemExit
print("1" if all((v.get("wave") or {}).get("status") == "RUNNING" for v in views) else "0")
PY
}

while true; do
  live=0
  cycle_live=0
  cycle_failed=0
  cycle_succeeded=0
  live_ids=""
  last_rc=0
  last_err=""
  shopt -s nullglob
  for db in "$LEDGER_DIR"/*.sqlite; do
    base="$(basename "$db")"
    [[ "$base" == acp-* ]] && continue
    repo="$(list_live_repo "$db")"
    if [[ -z "$repo" ]]; then
      continue
    fi
    live=1
    cycle_live=$((cycle_live + 1))
    tick_json="$WR_SCRATCH/supervisor-last-tick.json"
    set +e
    if [[ -n "$TARGET_WAVE" ]]; then
      tick_args=(node "$CLI_JS" tick --wave "$TARGET_WAVE" --db "$db" --repo "$repo" --supervised \
        --worktree-root "$WR_SCRATCH/supervisor-worktrees" \
        --artifact-root "$WR_SCRATCH/supervisor-artifacts")
    else
      tick_args=(node "$CLI_JS" tick-all --db "$db" --repo "$repo" --supervised \
        --worktree-root "$WR_SCRATCH/supervisor-worktrees" \
        --artifact-root "$WR_SCRATCH/supervisor-artifacts")
    fi
    if [[ "${WAVE_RUNNER_ACP:-1}" == "0" ]]; then
      tick_args+=(--no-acp)
    fi
    if [[ -n "${WAVE_RUNNER_LAUNCHER:-}" ]]; then
      tick_args+=(--launcher "$WAVE_RUNNER_LAUNCHER")
    fi
    "${tick_args[@]}" \
      >"$tick_json" 2>"$WR_SCRATCH/supervisor-last-tick.err"
    rc=$?
    set -e
    if [[ "$rc" -ne 0 ]]; then
      last_rc="$rc"
      last_err="$(tr '\n' ' ' <"$WR_SCRATCH/supervisor-last-tick.err" | head -c 400)"
      cycle_failed=$((cycle_failed + 1))
      TICK_FAIL_BY_SCOPE["$db"]=$(( ${TICK_FAIL_BY_SCOPE["$db"]:-0} + 1 ))
      echo "TICK_FAIL scope=$db streak=${TICK_FAIL_BY_SCOPE[$db]} rc=$rc err=$last_err" >&2
    else
      cycle_succeeded=$((cycle_succeeded + 1))
      TICK_FAIL_BY_SCOPE["$db"]=0
      if [[ -n "$TARGET_WAVE" ]]; then
        ids="$TARGET_WAVE"
      else
        ids="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(",".join(d.get("waveIds") or []))' "$tick_json" 2>/dev/null || true)"
      fi
      live_ids="${live_ids:+$live_ids,}$ids"
      if [[ "$(all_running_views "$tick_json")" == "1" ]]; then
        fp="$(fingerprint_views "$tick_json" 2>/dev/null || true)"
        live_work="$(has_live_work_views "$tick_json" 2>/dev/null || echo 0)"
        if [[ "$live_work" == "1" || -z "$fp" ]]; then
          STUCK_N=0
          PREV_FP="$fp"
        elif [[ "$fp" == "$PREV_FP" ]]; then
          STUCK_N=$((STUCK_N + 1))
          if [[ "$STUCK_TICKS" =~ ^[0-9]+$ && "$STUCK_TICKS" -gt 0 && "$STUCK_N" -ge "$STUCK_TICKS" ]]; then
            write_supervisor_heartbeat 1 "$live_ids" "stuck"
            echo "OPERATOR_STOP stuck" >&2
            exit 1
          fi
        else
          STUCK_N=0
          PREV_FP="$fp"
        fi
      else
        STUCK_N=0
        PREV_FP=""
      fi
    fi
  done
  if [[ "$cycle_live" -gt 0 && "$cycle_failed" -gt 0 && "$cycle_succeeded" -eq 0 ]]; then
    ALL_FAIL_N=$((ALL_FAIL_N + 1))
  else
    ALL_FAIL_N=0
  fi
  write_supervisor_heartbeat "$last_rc" "$live_ids" "$last_err"
  if [[ "$ALL_FAIL_N" -ge 5 ]]; then
    echo "OPERATOR_STOP repeated_tick_fail streak=$ALL_FAIL_N" >&2
    exit 1
  fi
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
