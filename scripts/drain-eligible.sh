#!/usr/bin/env bash
# WR-014/015 — Operator drain of agent_eligible open tickets (0 LLM orchestration tokens).
# Usage:
#   REPO=/path/to/repo ./scripts/drain-eligible.sh
#   REPO=/path/to/repo OVERNIGHT=1 ./scripts/drain-eligible.sh   # long/overnight kick (no wall)
#   REPO=/path/to/repo MAX_PARALLEL=5 TICKETS_FILE=/tmp/q.txt ./scripts/drain-eligible.sh
#
# Selects open + agent_eligible tickets with satisfied deps, lanes by writer scope,
# runs supervised waves until empty or human hold. Not autonomous overnight cron.
set -euo pipefail

: "${REPO:?REPO required}"
WR="${WR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
OUT_ROOT="${OUT_ROOT:-$(pwd)/tmp/drain-eligible-$(date +%Y%m%d%H%M%S)}"
MAX_PARALLEL="${MAX_PARALLEL:-5}"
OVERNIGHT="${OVERNIGHT:-0}"
export OPENCLAW_GATEWAY_URL="${OPENCLAW_GATEWAY_URL:-http://127.0.0.1:18789}"
TOKEN_FILE="${OPENCLAW_HOME:+$OPENCLAW_HOME/secrets/gateway-token}"
TOKEN_FILE="${TOKEN_FILE:-${HOME:+$HOME/.openclaw/secrets/gateway-token}}"
if [[ -z "${OPENCLAW_GATEWAY_TOKEN:-}" && -n "${TOKEN_FILE:-}" && -f "$TOKEN_FILE" ]]; then
  export OPENCLAW_GATEWAY_TOKEN="$(tr -d '[:space:]' <"$TOKEN_FILE")"
fi
export WAVE_RUNNER_ACP="${WAVE_RUNNER_ACP:-1}"
export PLUGIN_DIR="${PLUGIN_DIR:-$WR}"
export WR
export MAX_LAUNCHES="${MAX_LAUNCHES:-10}"
export MAX_TOKENS="${MAX_TOKENS:-500000}"
export MAX_WALL_MS="${MAX_WALL_MS:-0}"
export TICK_SLEEP="${TICK_SLEEP:-20}"
export AUTO_PLAN_GATE="${AUTO_PLAN_GATE:-1}"

mkdir -p "$OUT_ROOT"
LOG="$OUT_ROOT/drain.log"
SUMMARY="$OUT_ROOT/SUMMARY.jsonl"
touch "$SUMMARY"
exec > >(tee -a "$LOG") 2>&1

echo "=== drain-eligible start $(date -Iseconds) REPO=$REPO OVERNIGHT=$OVERNIGHT MAX_PARALLEL=$MAX_PARALLEL ==="
echo "note: operator drain (WR-014/015). No LLM control loop. Autonomous overnight remains OFF."

TICKETS_FILE="${TICKETS_FILE:-}"
if [[ -z "$TICKETS_FILE" ]]; then
  TICKETS_FILE="$OUT_ROOT/eligible.txt"
  python3 - "$REPO" "$TICKETS_FILE" <<'PY'
import re, sys
from pathlib import Path

repo = Path(sys.argv[1])
out = Path(sys.argv[2])
issues = repo / "issues"
if not issues.is_dir():
    raise SystemExit(f"no issues/ under {repo}")

TERMINAL = {"done", "wontfix", "cancelled", "closed", "complete", "completed"}

def parse_fm(text: str) -> dict:
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end < 0:
        return {}
    block = text[3:end]
    data = {}
    for line in block.splitlines():
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        data[k.strip()] = v.strip().strip('"').strip("'")
    return data

def deps_of(data: dict) -> list[str]:
    raw = data.get("depends_on") or data.get("blocked_by") or data.get("depends") or ""
    if raw.startswith("[") and raw.endswith("]"):
        inner = raw[1:-1].strip()
        if not inner:
            return []
        return [x.strip().strip('"').strip("'") for x in inner.split(",") if x.strip()]
    if not raw or raw in ("null", "[]", "~"):
        return []
    return [raw]

catalog = {}
for path in issues.rglob("*.md"):
    if path.name.upper() == "README.MD" or path.name.upper() == "BOARD.MD":
        continue
    text = path.read_text(errors="replace")
    data = parse_fm(text)
    tid = data.get("id") or data.get("ticket") or data.get("issue")
    if not tid:
        m = re.match(r"([A-Z]+-\d+)", path.name)
        if not m:\n            continue\n        tid = m.group(1)\n    status = (data.get("status") or data.get("state") or "open").lower()
    elig = (data.get("eligibility") or "").lower()
    agent = (data.get("agent_eligible") or "").lower()
    eligible = elig == "agent_eligible" or agent in ("true", "yes", "1")
    catalog[tid] = {
        "status": status,
        "eligible": eligible,
        "deps": deps_of(data),
        "path": str(path),
    }

def deps_ok(tid: str) -> bool:
    for dep in catalog.get(tid, {}).get("deps") or []:
        d = catalog.get(dep)
        if not d:\n            return False\n        if d["status"] not in TERMINAL:
            return False
    return True

eligible = []
for tid, meta in sorted(catalog.items()):
    if meta["status"] in TERMINAL:
        continue
    if meta["status"] not in ("open", "in_progress", "todo", "ready", ""):
        # skip blocked/plan_review human holds unless agent_eligible open-ish
        if meta["status"] in ("blocked", "plan_review"):
            continue
    if not meta["eligible"]:
        continue
    if not deps_ok(tid):
        continue
    eligible.append(tid)

out.write_text("\n".join(eligible) + ("\n" if eligible else ""))
print(f"eligible_count={len(eligible)}")
for tid in eligible:
    print(f"  {tid}")
PY
fi

if [[ ! -s "$TICKETS_FILE" ]]; then
  echo "NO_ELIGIBLE"
  echo "{\"event\":\"empty\",\"at\":\"$(date -Iseconds)\"}" >>"$SUMMARY"
  exit 0
fi

export TICKETS_FILE OUT_ROOT MAX_PARALLEL
bash "$WR/scripts/run-backlog-parallel.sh"
echo "=== drain-eligible complete $(date -Iseconds) ==="
echo "{\"event\":\"complete\",\"at\":\"$(date -Iseconds)\",\"out\":\"$OUT_ROOT\"}" >>"$SUMMARY"
