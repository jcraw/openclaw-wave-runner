#!/usr/bin/env bash
# Parallel backlog: one supervised lane per writer scope / product.
# Usage:
#   REPO=/path/to/game_jam \
#   TICKETS_FILE=/tmp/queue.txt \
#   OUT_ROOT=/tmp/backlog-par \
#   ./scripts/run-backlog-parallel.sh
#
# tickets file lines: TICKET or TICKET|scopeHint
# Lanes group by issues/<board>/ when ticket md is found; else ticket prefix.
set -euo pipefail

: "${REPO:?REPO required}"
: "${TICKETS_FILE:?TICKETS_FILE required}"
OUT_ROOT="${OUT_ROOT:-$(pwd)/tmp/backlog-parallel-$(date +%Y%m%d%H%M%S)}"
WR="${WR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
MAX_PARALLEL="${MAX_PARALLEL:-5}"
export PATH="/home/j/.nvm/versions/node/v24.18.1/bin:$PATH"
export OPENCLAW_GATEWAY_URL="${OPENCLAW_GATEWAY_URL:-http://127.0.0.1:18789}"
if [[ -z "${OPENCLAW_GATEWAY_TOKEN:-}" && -f /home/j/.openclaw/secrets/gateway-token ]]; then
  export OPENCLAW_GATEWAY_TOKEN="$(tr -d '[:space:]' </home/j/.openclaw/secrets/gateway-token)"
fi
export WAVE_RUNNER_ACP="${WAVE_RUNNER_ACP:-1}"
export PLUGIN_DIR="${PLUGIN_DIR:-$WR}"
export WR

mkdir -p "$OUT_ROOT"
echo "parallel backlog OUT_ROOT=$OUT_ROOT MAX_PARALLEL=$MAX_PARALLEL"

# Build lane -> tickets map
python3 - "$REPO" "$TICKETS_FILE" "$OUT_ROOT" <<'PY'
import re, sys
from pathlib import Path
from collections import defaultdict
repo, tickets_file, out_root = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
lines = [ln.strip() for ln in tickets_file.read_text().splitlines() if ln.strip() and not ln.startswith("#")]
lanes = defaultdict(list)
for ln in lines:
    tid = ln.split("|", 1)[0].strip()
    hint = ln.split("|", 1)[1].strip() if "|" in ln else ""
    scope = hint
    if not scope:
        hits = list(repo.joinpath("issues").rglob(f"{tid}-*.md"))
        if hits:
            rel = hits[0].relative_to(repo).as_posix()
            m = re.search(r"issues/([^/]+)/", rel)
            scope = f"board:{m.group(1)}" if m else f"prefix:{tid.split('-')[0]}"
        else:
            scope = f"prefix:{tid.split('-')[0]}"
    lanes[scope].append(tid)
lane_dir = out_root / "lanes"
lane_dir.mkdir(parents=True, exist_ok=True)
for scope, tids in lanes.items():
    safe = re.sub(r"[^a-zA-Z0-9._-]+", "-", scope)
    (lane_dir / f"{safe}.txt").write_text("\n".join(tids) + "\n")
    print(f"lane {scope}: {', '.join(tids)}")
(out_root / "lane-list.txt").write_text("\n".join(sorted(p.name for p in lane_dir.glob('*.txt'))) + "\n")
PY

run_lane() {
  local lane_file="$1"
  local lane_name
  lane_name="$(basename "$lane_file" .txt)"
  local lane_out="$OUT_ROOT/run/$lane_name"
  mkdir -p "$lane_out"
  local log="$lane_out/lane.log"
  {
    echo "=== lane $lane_name start $(date -Iseconds) ==="
    while read -r ticket; do
      [[ -z "$ticket" ]] && continue
      local wave_out="$lane_out/waves/$ticket"
      mkdir -p "$wave_out"
      export WAVE_ID="PAR-${lane_name}-${ticket}-$(date +%H%M%S)"
      export REPO
      export OUT_DIR="$wave_out"
      export TICKETS="$ticket"
      export MAX_LAUNCHES="${MAX_LAUNCHES:-10}"
      export MAX_TOKENS="${MAX_TOKENS:-500000}"
      export MAX_WALL_MS="${MAX_WALL_MS:-0}"
      export TICK_SLEEP=20
      echo ">> $ticket"
      if bash "$WR/scripts/run-backlog-wave.sh"; then
        # mark done on board when completed
        python3 - "$REPO" "$ticket" <<'PY' || true
import re, datetime, sys
from pathlib import Path
repo, tid = Path(sys.argv[1]), sys.argv[2]
files=list(repo.joinpath("issues").rglob(f"{tid}-*.md"))
if not files: raise SystemExit(0)
p=files[0]; t=p.read_text()
t=re.sub(r"(?m)^status:\s*\S+","status: done",t,count=1)
t=re.sub(r"(?m)^updated:\s*\S+",f"updated: {datetime.date.today().isoformat()}",t,count=1)
p.write_text(t)
print("marked", p)
PY
        echo "OK $ticket"
      else
        echo "FAIL $ticket"
      fi
    done < "$lane_file"
    echo "=== lane $lane_name end $(date -Iseconds) ==="
  } >"$log" 2>&1
}

# fan-out lanes with MAX_PARALLEL
pids=()
for lane in "$OUT_ROOT"/lanes/*.txt; do
  while (( ${#pids[@]} >= MAX_PARALLEL )); do
    for i in "${!pids[@]}"; do
      if ! kill -0 "${pids[$i]}" 2>/dev/null; then
        unset 'pids[i]'
      fi
    done
    pids=("${pids[@]}")
    sleep 2
  done
  run_lane "$lane" &
  pids+=("$!")
  echo "spawned lane $(basename "$lane") pid $!"
done
for pid in "${pids[@]}"; do
  wait "$pid" || true
done
echo "ALL LANES FINISHED $(date -Iseconds)"
ls -la "$OUT_ROOT/run" || true
