#!/usr/bin/env bash
# WR-014/034 — Operator drain of agent_eligible open tickets (0 LLM orchestration tokens).
# Usage:
#   REPO=/path/to/repo ./scripts/drain-eligible.sh
#   REPO=/path/to/repo WAVE_WALL_S=3600 ./scripts/drain-eligible.sh   # optional timeout (seconds)
#   REPO=/path/to/repo MAX_PARALLEL=5 TICKETS_FILE=/tmp/q.txt ./scripts/drain-eligible.sh
#
# Selects open + agent_eligible tickets with satisfied deps and a non-empty verify,
# lanes by writer scope, runs supervised waves until empty or human hold.
# Not unprompted re-drain / LLM poll. Exit 1 unless every kicked ticket is DONE (land.ok)
# unless WAVE_DRAIN_BEST_EFFORT=1.
# Do not default or export OVERNIGHT; a caller-set OVERNIGHT=1 must reach run-backlog-wave.sh.
set -euo pipefail

: "${REPO:?REPO required}"
WR="${WR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
WR_SCRATCH="${WR_SCRATCH:-/run/media/j/866e11e8-6c31-4c0c-a07c-704845033900/ai/wave-runner}"
_scratch_uuid="$(findmnt -n -o UUID -T "$WR_SCRATCH" 2>/dev/null || true)"
if [[ "$_scratch_uuid" != "866e11e8-6c31-4c0c-a07c-704845033900" ]]; then
  echo "error: Wave Runner scratch is not on the 7.3T data disk (unmounted or wrong UUID): $WR_SCRATCH" >&2
  exit 1
fi
OUT_ROOT="${OUT_ROOT:-$WR_SCRATCH/drain-eligible-$(date +%Y%m%d%H%M%S)}"
MAX_PARALLEL="${MAX_PARALLEL:-5}"
export OPENCLAW_GATEWAY_URL="${OPENCLAW_GATEWAY_URL:-http://127.0.0.1:18789}"
TOKEN_FILE="${OPENCLAW_HOME:+$OPENCLAW_HOME/secrets/gateway-token}"
TOKEN_FILE="${TOKEN_FILE:-${HOME:+$HOME/.openclaw/secrets/gateway-token}}"
if [[ -z "${OPENCLAW_GATEWAY_TOKEN:-}" && -n "${TOKEN_FILE:-}" && -f "$TOKEN_FILE" ]]; then
  export OPENCLAW_GATEWAY_TOKEN="$(tr -d '[:space:]' <"$TOKEN_FILE")"
fi
export WAVE_RUNNER_ACP="${WAVE_RUNNER_ACP:-1}"
export PLUGIN_DIR="${PLUGIN_DIR:-$WR}"
if [[ "$PLUGIN_DIR" == *agent-backlog-wave-runner* || "$WR" == *agent-backlog-wave-runner* ]]; then
  echo "error: refusing stale workspace plugin PLUGIN_DIR=$PLUGIN_DIR WR=$WR" >&2
  exit 2
fi
if [[ ! -f "$PLUGIN_DIR/dist/src/core/land-closeout.js" ]]; then
  echo "error: PLUGIN_DIR=$PLUGIN_DIR has no land-closeout (stale WR)" >&2
  exit 2
fi
export WR
export MAX_LAUNCHES="${MAX_LAUNCHES:-10}"
export MAX_TOKENS="${MAX_TOKENS:-500000}"
export MAX_WALL_MS="${MAX_WALL_MS:-0}"
export TICK_SLEEP="${TICK_SLEEP:-20}"
export AUTO_PLAN_GATE="${AUTO_PLAN_GATE:-1}"
# Jam drain: files into the primary workdir. Caller/ticket `land: commit` still wins in-process.
if [[ -z "${WAVE_LAND_MODE:-}" ]]; then
  export WAVE_LAND_MODE=apply
fi

mkdir -p "$OUT_ROOT"
LOG="$OUT_ROOT/drain.log"
SUMMARY="$OUT_ROOT/SUMMARY.jsonl"
touch "$SUMMARY"
exec > >(tee -a "$LOG") 2>&1

# Banner wall matches run-backlog-wave.sh: WAVE_WALL_S wins; else 0.
if [[ -n "${WAVE_WALL_S:-}" ]]; then
  WALL_S="$WAVE_WALL_S"
else
  WALL_S=0
fi
echo "=== drain-eligible start $(date -Iseconds) REPO=$REPO WALL_S=$WALL_S MAX_PARALLEL=$MAX_PARALLEL ==="
echo "note: operator drain (WR-014/034). No LLM control loop. Unprompted re-drain / LLM poll stay off."

TICKETS_FILE="${TICKETS_FILE:-}"
if [[ -z "$TICKETS_FILE" ]]; then
  TICKETS_FILE="$OUT_ROOT/eligible.txt"
  SELECT_JS="${SELECT_JS:-$WR/dist/scripts/select-eligible.js}"
  if [[ ! -f "$SELECT_JS" ]]; then
    echo "error: missing $SELECT_JS — run npm run build in $WR" >&2
    exit 2
  fi
  node "$SELECT_JS" --repo "$REPO" --out "$TICKETS_FILE" --skipped "$OUT_ROOT/SKIPPED.jsonl"
fi

if [[ ! -s "$TICKETS_FILE" ]]; then
  echo "NO_ELIGIBLE"
  echo "{\"event\":\"empty\",\"at\":\"$(date -Iseconds)\"}" >>"$SUMMARY"
  if [[ -s "$OUT_ROOT/SKIPPED.jsonl" ]]; then
    echo "kicked tickets were skipped (see SKIPPED.jsonl); not success"
    [[ "${WAVE_DRAIN_BEST_EFFORT:-}" == "1" ]] && exit 0
    exit 1
  fi
  exit 0
fi

export TICKETS_FILE OUT_ROOT MAX_PARALLEL
set +e
bash "$WR/scripts/run-backlog-parallel.sh"
rc=$?
set -e
echo "=== drain-eligible complete $(date -Iseconds) rc=$rc ==="
echo "{\"event\":\"complete\",\"at\":\"$(date -Iseconds)\",\"out\":\"$OUT_ROOT\",\"rc\":$rc}" >>"$SUMMARY"
exit "$rc"
