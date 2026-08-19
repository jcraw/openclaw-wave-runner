#!/usr/bin/env bash
# Run one supervised Wave Runner wave to terminal (or human hold).
# Usage:
#   REPO=/path/to/repo TICKETS=A-001 OUT_DIR=/tmp/wave ./scripts/run-backlog-wave.sh
#
# AUTO_PLAN_GATE=1 (default): ledger approve if a wave still sits on AWAITING_PLAN_GATE.
# Never bash-stamp APPROVED by Astra. Agent tickets auto-approve in the controller (WR-023).
# AUTO_PLAN_GATE=0: sleep-wait only (external approve).
# Scratch defaults to the 7.3T data disk (not $HOME). Override with WR_SCRATCH / OUT_DIR.
set -euo pipefail
: "${REPO:?}"
: "${TICKETS:?}"
WR_SCRATCH="${WR_SCRATCH:-/run/media/j/866e11e8-6c31-4c0c-a07c-704845033900/ai/wave-runner}"
_scratch_uuid="$(findmnt -n -o UUID -T "$WR_SCRATCH" 2>/dev/null || true)"
if [[ "$_scratch_uuid" != "866e11e8-6c31-4c0c-a07c-704845033900" ]]; then
  echo "error: Wave Runner scratch is not on the 7.3T data disk (unmounted or wrong UUID): $WR_SCRATCH" >&2
  exit 1
fi
OUT_DIR="${OUT_DIR:-$WR_SCRATCH/wave-runs/wave-$(date +%Y%m%d%H%M%S)}"
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

RESULT_JS="${RESULT_JS:-$PLUGIN_DIR/dist/scripts/wave-result.js}"
write_skip() {
  local outcome="$1"
  local reason="$2"
  if [[ -f "$RESULT_JS" ]]; then
    node "$RESULT_JS" write --out "$OUT_DIR/WAVE_RESULT.json" --ticket "$TICKETS" \
      --wave "$WAVE_ID" --outcome "$outcome" --reason "$reason" --land-ok 0 \
      ${LANE_SUMMARY:+--lane-summary "$LANE_SUMMARY"} || true
  fi
}

write_inspect_result() {
  local inspect_json="$1"
  if [[ -f "$RESULT_JS" && -s "$inspect_json" ]]; then
    node "$RESULT_JS" from-inspect --inspect "$inspect_json" --out "$OUT_DIR/WAVE_RESULT.json" \
      --wave "$WAVE_ID" --ticket "$TICKETS" \
      ${LANE_SUMMARY:+--lane-summary "$LANE_SUMMARY"} || true
  fi
}

if ! bash "$SCRIPT_DIR/wave-operator.sh" dry-run >/dev/null; then
  reason="dry-run failed"
  if [[ -s "$OUT_DIR/cli/dry-run.err" ]] && grep -q missing_verify "$OUT_DIR/cli/dry-run.err"; then
    reason="missing_verify $TICKETS"
  fi
  echo "PREFLIGHT_FAIL $reason" >&2
  write_skip SKIPPED "$reason"
  exit 1
fi
if [[ "${WAVE_PRIMARY_DIRTY:-}" != "allow" ]]; then
  if ! python3 - "$OUT_DIR/cli/dry-run.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
hits = [b for b in (d.get("admitBlockers") or []) if b.get("code") == "primary_dirty_overlap"]
if hits:
    print("PREFLIGHT_FAIL primary_dirty_overlap " + ",".join(h.get("ticketId") or "?" for h in hits), file=sys.stderr)
    sys.exit(1)
PY
  then
    write_skip SKIPPED "primary_dirty_overlap $TICKETS"
    exit 1
  fi
fi
bash "$SCRIPT_DIR/wave-operator.sh" create
bash "$SCRIPT_DIR/wave-operator.sh" start

i=0
started=$(date +%s)
while true; do
  i=$((i + 1))
  printf -v nn "%02d" "$i"
  if (( $(date +%s) - started > 21600 )); then
    echo "FATAL wall"
    write_skip FAILED "wall clock"
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
    COMPLETED)
      write_inspect_result "${fp_json:-$OUT_DIR/cli/inspect.json}"
      echo WAVE_OK
      exit 0
      ;;
    FAILED|CANCELLED|BUDGET_STOPPED|BLOCKED)
      write_inspect_result "${fp_json:-$OUT_DIR/cli/inspect.json}"
      echo "WAVE_BAD $st"
      exit 1
      ;;
    WAITING_APPROVAL)
      write_inspect_result "${fp_json:-$OUT_DIR/cli/inspect.json}"
      echo "OPERATOR_STOP waiting_human"
      exit 0
      ;;
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
      bash "$SCRIPT_DIR/wave-operator.sh" approve "$tid" "$rev"
      sleep 2
      continue
      ;;
    *)
      sleep "$TICK_SLEEP"
      ;;
  esac
done
