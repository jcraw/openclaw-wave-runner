#!/usr/bin/env bash
# Run one supervised Wave Runner wave to terminal (or human hold).
# Usage:
#   REPO=/path/to/repo TICKETS=A-001 OUT_DIR=/tmp/wave ./scripts/run-backlog-wave.sh
#
# AUTO_PLAN_GATE=1 (default): common-sense stamp + approve on AWAITING_PLAN_GATE.
# AUTO_PLAN_GATE=0: sleep-wait only (external Astra approve).
set -euo pipefail
: "${REPO:?}"
: "${TICKETS:?}"
OUT_DIR="${OUT_DIR:-$(pwd)/tmp/wave-runs/wave-$(date +%Y%m%d%H%M%S)}"
WAVE_ID="${WAVE_ID:-BL-$(date +%Y%m%d%H%M%S)}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PLUGIN_DIR="${PLUGIN_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
export WR="${WR:-$PLUGIN_DIR}"
export WAVE_ID REPO OUT_DIR TICKETS
export MAX_LAUNCHES="${MAX_LAUNCHES:-10}"
export MAX_TOKENS="${MAX_TOKENS:-500000}"
export MAX_WALL_MS="${MAX_WALL_MS:-0}"
export TICK_SLEEP="${TICK_SLEEP:-20}"
export STUCK_TICKS="${STUCK_TICKS:-20}"
export WAVE_RUNNER_ACP="${WAVE_RUNNER_ACP:-1}"
AUTO_PLAN_GATE="${AUTO_PLAN_GATE:-1}"
STUCK_N=0
PREV_FP=""
mkdir -p "$OUT_DIR/cli"

export OPENCLAW_GATEWAY_URL="${OPENCLAW_GATEWAY_URL:-http://127.0.0.1:18789}"
TOKEN_FILE="${OPENCLAW_HOME:+$OPENCLAW_HOME/secrets/gateway-token}"
TOKEN_FILE="${TOKEN_FILE:-${HOME:+$HOME/.openclaw/secrets/gateway-token}}"
if [[ -z "${OPENCLAW_GATEWAY_TOKEN:-}" && -n "${TOKEN_FILE:-}" && -f "$TOKEN_FILE" ]]; then
  export OPENCLAW_GATEWAY_TOKEN="$(tr -d '[:space:]' <"$TOKEN_FILE")"
fi

echo "run-backlog-wave WAVE_ID=$WAVE_ID OUT_DIR=$OUT_DIR TICKETS=$TICKETS AUTO_PLAN_GATE=$AUTO_PLAN_GATE"

status_of() {
  python3 - "$1" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
w=d.get("wave") or d
print(w.get("status") or "")
PY
}

ticket_info() {
  python3 - "$1" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
for t in d.get("tickets") or []:
    if t.get("status") == "PLAN_REVIEW":
        tid=t.get("ticketId") or t.get("id")
        rev=t.get("revision") if t.get("revision") is not None else t.get("rev")
        print(f"{tid}\t{rev}")
PY
}

# Same field set as src/core/operator-loop.ts progressFingerprint.
fingerprint_of_json() {
  python3 - "$1" <<'PY'
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
PY
}

# Same predicate as src/core/operator-loop.ts hasLiveOutbox.
has_live_outbox() {
  python3 - "$1" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
live={"CLAIMED","LAUNCHED","RECONCILING"}
print("1" if any((o.get("state") or "") in live for o in (d.get("outbox") or [])) else "0")
PY
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

bash "$SCRIPT_DIR/wave-operator.sh" dry-run >/dev/null || true
bash "$SCRIPT_DIR/wave-operator.sh" create
bash "$SCRIPT_DIR/wave-operator.sh" start

i=0
started=$(date +%s)
while true; do
  i=$((i + 1))
  printf -v nn "%02d" "$i"
  if (( $(date +%s) - started > 21600 )); then
    echo "FATAL wall"
    exit 1
  fi
  bash "$SCRIPT_DIR/wave-operator.sh" tick "$nn" || true
  st=""
  fp_json=""
  if [[ -s "$OUT_DIR/cli/tick-${nn}.json" ]]; then
    st="$(status_of "$OUT_DIR/cli/tick-${nn}.json" 2>/dev/null || true)"
    fp_json="$OUT_DIR/cli/tick-${nn}.json"
  fi
  if [[ -z "$st" ]]; then
    bash "$SCRIPT_DIR/wave-operator.sh" inspect >/dev/null || true
    st="$(status_of "$OUT_DIR/cli/inspect.json" 2>/dev/null || true)"
    fp_json="$OUT_DIR/cli/inspect.json"
  fi
  note_stuck "$st" "$fp_json"
  echo "status=$st"
  case "$st" in
    COMPLETED) echo WAVE_OK; exit 0 ;;
    FAILED|CANCELLED|BUDGET_STOPPED|BLOCKED) echo "WAVE_BAD $st"; exit 1 ;;
    WAITING_APPROVAL) echo "OPERATOR_STOP waiting_human"; exit 0 ;;
    AWAITING_PLAN_GATE)
      if [[ "$AUTO_PLAN_GATE" != "1" ]]; then
        sleep "$TICK_SLEEP"
        continue
      fi
      bash "$SCRIPT_DIR/wave-operator.sh" inspect >/dev/null || true
      info="$(ticket_info "$OUT_DIR/cli/inspect.json" 2>/dev/null | head -1 || true)"
      tid="$(printf '%s' "$info" | cut -f1)"
      rev="$(printf '%s' "$info" | cut -f2)"
      if [[ -z "$tid" || -z "$rev" ]]; then
        echo "FATAL no plan-review rev"
        exit 1
      fi
      plan="$(find "$OUT_DIR" -name PLAN.md 2>/dev/null | head -1 || true)"
      if [[ -n "${plan:-}" && -f "$plan" ]]; then
        if ! grep -q "APPROVED by Astra" "$plan"; then
          printf '\n\nStatus: APPROVED by Astra %s (auto plan-gate)\n' \
            "$(date '+%Y-%m-%d %H:%M %Z')" >>"$plan"
        fi
      fi
      bash "$SCRIPT_DIR/wave-operator.sh" approve "$tid" "$rev"
      sleep 2
      continue
      ;;
    *)
      sleep "$TICK_SLEEP"
      ;;
  esac
done
