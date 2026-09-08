#!/usr/bin/env bash
# Sourced by wave-supervisor.sh and run-backlog-wave.sh (WR-046).
# Operator ids: [A-Za-z0-9._:-] only. Never inherit a filesystem path.

RUN_OPERATOR_ID="${RUN_OPERATOR_ID:-supervisor-wave-runner}"

assert_safe_operator_id() {
  local value="${1:-}"
  [[ "$value" =~ ^[A-Za-z0-9._:-]+$ ]] || return 1
  [[ ${#value} -ge 1 && ${#value} -le 160 ]] || return 1
}

resolve_run_operator_id() {
  local from_env="${WAVE_RUNNER_OPERATOR_ID:-}"
  if [[ -z "$from_env" ]]; then
    WAVE_RUNNER_OPERATOR_ID="$RUN_OPERATOR_ID"
    export WAVE_RUNNER_OPERATOR_ID
    return 0
  fi
  if ! assert_safe_operator_id "$from_env"; then
    echo "error: WAVE_RUNNER_OPERATOR_ID is empty or unsafe: $from_env" >&2
    return 1
  fi
  export WAVE_RUNNER_OPERATOR_ID="$from_env"
}

supervisor_heartbeat_file() {
  echo "${WR_SCRATCH%/}/supervisor.heartbeat"
}

write_supervisor_heartbeat() {
  local rc="${1:-0}"
  local waves="${2:-}"
  local err="${3:-}"
  python3 - "$rc" "$waves" "$err" "$(supervisor_heartbeat_file)" "$$" <<'PY'
import json, sys, time
rc, waves, err, path, pid = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
live = [w for w in waves.split(",") if w]
payload = {
    "ts": int(time.time()),
    "pid": int(pid),
    "rc": int(rc),
    "liveWaves": live,
    "lastError": err[:400],
}
open(path, "w", encoding="utf8").write(json.dumps(payload, separators=(",", ":")) + "\n")
PY
}

supervisor_heartbeat_fresh() {
  local sleep_s="${TICK_SLEEP:-20}"
  local file
  file="$(supervisor_heartbeat_file)"
  [[ -f "$file" ]] || return 1
  python3 - "$file" "$sleep_s" <<'PY'
import json, sys, time
path, sleep_s = sys.argv[1], float(sys.argv[2] or 20)
try:
    hb = json.load(open(path, encoding="utf8"))
except Exception:
    raise SystemExit(1)
age = time.time() - float(hb.get("ts") or 0)
raise SystemExit(0 if age < 3 * max(1.0, sleep_s) else 1)
PY
}

resolve_grok_launcher() {
  if [[ -n "${WAVE_RUNNER_LAUNCHER:-}" ]]; then
    export WAVE_RUNNER_LAUNCHER
    return 0
  fi
  if [[ -n "${DEFAULT_GROK_LAUNCHER:-}" && -x "${DEFAULT_GROK_LAUNCHER}" ]]; then
    WAVE_RUNNER_LAUNCHER="$DEFAULT_GROK_LAUNCHER"
    export WAVE_RUNNER_LAUNCHER
    return 0
  fi
  local health_dir wr_root sibling
  health_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  wr_root="$(cd "$health_dir/.." && pwd)"
  sibling="$wr_root/../game_jam/tools/run_detached_builder.sh"
  if [[ -x "$sibling" ]]; then
    WAVE_RUNNER_LAUNCHER="$(cd "$(dirname "$sibling")" && pwd)/run_detached_builder.sh"
    export WAVE_RUNNER_LAUNCHER
  fi
}

supervisor_alive() {
  local pidfile="${WAVE_SUPERVISOR_PIDFILE:-${WR_SCRATCH%/}/supervisor.pid}"
  [[ -f "$pidfile" ]] || return 1
  local pid
  pid="$(tr -d '[:space:]' <"$pidfile" 2>/dev/null || true)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null || return 1
  supervisor_heartbeat_fresh
}

# Do not treat parent $! as healthy. Wait for pid AND a fresh heartbeat.
wait_supervisor_alive() {
  local tries="${1:-50}"
  local i=0
  while (( i < tries )); do
    if supervisor_alive; then
      return 0
    fi
    sleep 0.1
    i=$((i + 1))
  done
  return 1
}
