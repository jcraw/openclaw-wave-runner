#!/usr/bin/env bash
# Run one supervised Wave Runner wave to terminal (or human hold).
# Usage:
#   REPO=/path/to/repo TICKETS=A-001,B-002 OUT_DIR=/tmp/wave \
#     ./scripts/run-backlog-wave.sh
#
# When status is AWAITING_PLAN_GATE, Astra approves:
#   WAVE_ID=... REPO=... OUT_DIR=... ./scripts/wave-operator.sh approve TICKET REV
set -euo pipefail
: "${REPO:?}"
: "${TICKETS:?}"
OUT_DIR="${OUT_DIR:-$(pwd)/tmp/wave-runs/wave-$(date +%Y%m%d%H%M%S)}"
WAVE_ID="${WAVE_ID:-BL-$(date +%Y%m%d%H%M%S)}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PLUGIN_DIR="${PLUGIN_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
export WAVE_ID REPO OUT_DIR TICKETS
export MAX_LAUNCHES="${MAX_LAUNCHES:-6}"
export MAX_TOKENS="${MAX_TOKENS:-50000}"
export MAX_WALL_MS="${MAX_WALL_MS:-0}"
export TICK_SLEEP="${TICK_SLEEP:-20}"
export WAVE_RUNNER_ACP="${WAVE_RUNNER_ACP:-1}"
mkdir -p "$OUT_DIR"
echo "run-backlog-wave WAVE_ID=$WAVE_ID OUT_DIR=$OUT_DIR TICKETS=$TICKETS"
exec bash "$SCRIPT_DIR/wave-operator.sh" all
