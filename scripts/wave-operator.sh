#!/usr/bin/env bash
# Wave Runner supervised operator (restored 2026-08-15).
# Real workers only via --supervised. No unrestricted drain. No overnight here.
# Plan-gate (AWAITING_PLAN_GATE): leftover wait; stay alive; do NOT bash-stamp APPROVED.
# Agent tickets auto-approve in the controller (WR-023). Do not invent Astra.
# Human hold (WAITING_APPROVAL): OPERATOR_STOP waiting_human; exit 0.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  wave-operator.sh dry-run|create|start|tick|inspect|approve|cancel|loop|all

Required env:
  WAVE_ID   REPO   OUT_DIR

Optional env:
  TICKETS            comma ids (create)
  MAX_LAUNCHES       default 10
  MAX_TOKENS         default 500000
  MAX_WALL_MS        default 0 (no elapsed deadline)
  MAX_TICKS          default 0 (unlimited)
  TICK_SLEEP         default 20
  STUCK_TICKS        default 20 (0 = disable). Frozen RUNNING, no live outbox → OPERATOR_STOP stuck
  WAVE_PLAN_WALL_MS  default 2700000 (45m). 0 = disable PLAN stage watchdog
  WAVE_IMPL_WALL_MS  default 5400000 (90m). 0 = disable IMPL stage watchdog
  WAVE_VERIFY_TIMEOUT_MS  default 300000. Controller verify exec timeout
  PLUGIN_DIR         package root (default: parent of scripts/)
  WAVE_RUNNER_ACP=1  enable ACP spawn path

Examples:
  WAVE_ID=W1 REPO=/path/to/repo OUT_DIR=/tmp/w1 TICKETS=GS-057 \
    ./scripts/wave-operator.sh all
EOF
}

PHASE="${1:-}"
if [[ -z "$PHASE" || "$PHASE" == "-h" || "$PHASE" == "--help" ]]; then
  usage
  exit 0
fi

: "${WAVE_ID:?WAVE_ID required}"
: "${REPO:?REPO required}"
: "${OUT_DIR:?OUT_DIR required}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="${PLUGIN_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
CLI_JS="${CLI_JS:-$PLUGIN_DIR/dist/scripts/wave-cli.js}"
if [[ ! -f "$CLI_JS" ]]; then
  echo "error: missing $CLI_JS — run npm run build in $PLUGIN_DIR" >&2
  exit 2
fi

mkdir -p "$OUT_DIR/cli" "$OUT_DIR/ticks" "$OUT_DIR/worktrees" "$OUT_DIR/artifacts"

MAX_LAUNCHES="${MAX_LAUNCHES:-10}"
MAX_TOKENS="${MAX_TOKENS:-500000}"
MAX_WALL_MS="${MAX_WALL_MS:-0}"
MAX_TICKS="${MAX_TICKS:-0}"
TICK_SLEEP="${TICK_SLEEP:-20}"
STUCK_TICKS="${STUCK_TICKS:-20}"
STUCK_N=0
PREV_FP=""

status_of_json() {
  python3 - "$1" <<'PY2'
import json,sys
p=sys.argv[1]
d=json.load(open(p))
w=d.get("wave") or d
print(w.get("status") or "")
PY2
}

# Same field set as src/core/operator-loop.ts progressFingerprint.
fingerprint_of_json() {
  python3 - "$1" <<'PY2'
import hashlib, json, sys
d=json.load(open(sys.argv[1]))
w=d.get("wave") or {}
payload={
  "status": w.get("status") or "",
  "tickets": sorted([
    {"id": t.get("ticketId") or t.get("id"), "status": t.get("status"),
     "revision": t.get("revision"), "result": t.get("result") or ""}
    for t in (d.get("tickets") or [])
  ], key=lambda x: str(x["id"] or "")),
  "outbox": sorted([
    {"id": o.get("outboxId") or o.get("id"), "state": o.get("state")}
    for o in (d.get("outbox") or [])
  ], key=lambda x: str(x["id"] or "")),
  "leases": sorted([
    {"key": l.get("resourceKey") or l.get("key"), "holder": l.get("holder"),
     "ticketId": l.get("ticketId") or ""}
    for l in (d.get("leases") or [])
  ], key=lambda x: str(x["key"] or "")),
}
print(hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest())
PY2
}

# Same predicate as src/core/operator-loop.ts hasLiveOutbox.
has_live_outbox() {
  python3 - "$1" <<'PY2'
import json,sys
d=json.load(open(sys.argv[1]))
live={"CLAIMED","LAUNCHED","RECONCILING"}
print("1" if any((o.get("state") or "") in live for o in (d.get("outbox") or [])) else "0")
PY2
}

note_stuck() {
  local st="$1"
  local json="$2"
  local fp=""
  local live="0"
  if [[ -n "$json" && -s "$json" ]]; then
    fp="$(fingerprint_of_json "$json" 2>/dev/null || true)"
    live="$(has_live_outbox "$json" 2>/dev/null || echo 0)"
  fi
  if [[ "$st" != "RUNNING" || -z "$fp" ]]; then
    STUCK_N=0
    PREV_FP=""
    return 0
  fi
  if [[ "$live" == "1" ]]; then
    STUCK_N=0
    PREV_FP="$fp"
    return 0
  fi
  if [[ "$fp" == "$PREV_FP" ]]; then
    STUCK_N=$((STUCK_N + 1))
    if [[ "$STUCK_TICKS" =~ ^[0-9]+$ && "$STUCK_TICKS" -gt 0 && "$STUCK_N" -ge "$STUCK_TICKS" ]]; then
      echo "OPERATOR_STOP stuck" >&2
      exit 1
    fi
  else
    STUCK_N=0
    PREV_FP="$fp"
  fi
}

run_cli() {
  local op="$1"; shift || true
  local out_json="$OUT_DIR/cli/${op}.json"
  local err_file="$OUT_DIR/cli/${op}.err"
  local args=(node "$CLI_JS" "$op"
    --db "$OUT_DIR/wave.sqlite"
    --repo "$REPO"
    --worktree-root "$OUT_DIR/worktrees"
    --artifact-root "$OUT_DIR/artifacts"
    --wave "$WAVE_ID"
    --supervised
  )
  case "$op" in
    dry-run|create)
      : "${TICKETS:?TICKETS required for $op}"
      args+=(--tickets "$TICKETS" --max-launches "$MAX_LAUNCHES" --max-tokens "$MAX_TOKENS" --max-wall-ms "$MAX_WALL_MS")
      ;;
    tick)
      local nn="${1:-}"
      if [[ -n "$nn" ]]; then
        out_json="$OUT_DIR/cli/tick-${nn}.json"
        err_file="$OUT_DIR/cli/tick-${nn}.err"
      fi
      ;;
    approve)
      local ticket="${1:-}"; local rev="${2:-}"
      : "${ticket:?ticket required}"; : "${rev:?revision required}"
      args+=(--ticket "$ticket" --revision "$rev")
      out_json="$OUT_DIR/cli/approve-${ticket}.json"
      err_file="$OUT_DIR/cli/approve-${ticket}.err"
      ;;
    inspect|start|cancel|pause|resume) ;;
    *)
      echo "error: unknown op $op" >&2
      exit 2
      ;;
  esac

  set +e
  "${args[@]}" >"$out_json" 2>"$err_file"
  local rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then
    echo "error: wave-cli $op failed rc=$rc" >&2
    cat "$err_file" >&2 || true
    return "$rc"
  fi
  if [[ "$op" == "inspect" ]]; then
    cp -f "$out_json" "$OUT_DIR/cli/inspect.json"
  fi
  cat "$out_json"
  return 0
}

case "$PHASE" in
  dry-run|create|start|inspect|cancel)
    run_cli "$PHASE"
    ;;
  tick)
    run_cli tick "${2:-}"
    ;;
  approve)
    run_cli approve "${2:-}" "${3:-}"
    ;;
  loop|all)
    if [[ "$PHASE" == "all" ]]; then
      run_cli dry-run >/dev/null || echo "dry-run soft-fail"
      run_cli create >/dev/null
      run_cli start >/dev/null
    fi
    i=0
    started=$(date +%s)
    while true; do
      i=$((i + 1))
      printf -v nn "%02d" "$i"
      if [[ "$MAX_TICKS" != "0" && "$i" -gt "$MAX_TICKS" ]]; then
        echo "OPERATOR_STOP max_ticks" >&2
        exit 1
      fi
      run_cli inspect >/dev/null || true
      st="$(status_of_json "$OUT_DIR/cli/inspect.json" 2>/dev/null || true)"
      note_stuck "$st" "$OUT_DIR/cli/inspect.json"
      case "$st" in
        COMPLETED)
          echo "WAVE_OK status=$st"
          exit 0
          ;;
        FAILED|CANCELLED|BUDGET_STOPPED|BLOCKED)
          echo "WAVE_BAD status=$st" >&2
          exit 1
          ;;
        WAITING_APPROVAL)
          echo "OPERATOR_STOP waiting_human" >&2
          exit 0
          ;;
        AWAITING_PLAN_GATE)
          echo "PLAN_GATE waiting_astra wave=$WAVE_ID (inspect-sleep ${TICK_SLEEP}s)"
          sleep "$TICK_SLEEP"
          continue
          ;;
        PAUSED)
          echo "OPERATOR_STOP paused" >&2
          exit 0
          ;;
        DRAFT|FROZEN)
          run_cli start >/dev/null || true
          ;;
        RUNNING|"")
          :
          ;;
      esac
      echo "=== tick $nn elapsed=$(( $(date +%s) - started ))s status=${st:-?} ==="
      if ! run_cli tick "$nn" >/dev/null; then
        echo "TICK_FAILED $nn" >&2
        exit 1
      fi
      st="$(status_of_json "$OUT_DIR/cli/tick-${nn}.json")"
      note_stuck "$st" "$OUT_DIR/cli/tick-${nn}.json"
      echo "status=$st"
      case "$st" in
        COMPLETED) echo "WAVE_OK"; exit 0 ;;
        FAILED|CANCELLED|BUDGET_STOPPED|BLOCKED) echo "WAVE_BAD status=$st" >&2; exit 1 ;;
        WAITING_APPROVAL) echo "OPERATOR_STOP waiting_human" >&2; exit 0 ;;
        AWAITING_PLAN_GATE)
          echo "PLAN_GATE waiting_astra"
          sleep "$TICK_SLEEP"
          continue
          ;;
      esac
      sleep "$TICK_SLEEP"
    done
    ;;
  *)
    echo "error: unknown phase $PHASE" >&2
    usage
    exit 2
    ;;
esac
