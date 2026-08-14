#!/usr/bin/env bash
# Disposable no-cost worker for Wave Runner supervised pilots.
# Speaks the GrokCliWorker receipt contract without calling Grok/Codex.
set -euo pipefail

repo=""
ticket=""
phase="planning"
prompt_file=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) repo="${2:-}"; shift 2 ;;
    --ticket) ticket="${2:-}"; shift 2 ;;
    --phase) phase="${2:-}"; shift 2 ;;
    --prompt-file) prompt_file="${2:-}"; shift 2 ;;
    --worker|--ticket-md) shift 2 ;;
    *) shift ;;
  esac
done

if [[ -z "$repo" || -z "$ticket" ]]; then
  echo "usage: no-cost-launcher.sh --repo DIR --ticket ID --phase planning|implementing" >&2
  exit 2
fi

out="$repo/tmp/workers/$ticket"
mkdir -p "$out"
pid="$$"
started="$(date -Iseconds)"
echo "ticket=$ticket" > "$out/meta.txt"
echo "worker=no-cost" >> "$out/meta.txt"
echo "phase=$phase" >> "$out/meta.txt"
echo "started=$started" >> "$out/meta.txt"
echo "builder_pid=$pid" >> "$out/meta.txt"
echo "$pid" > "$out/grok.pid"
echo "$started" > "$out/started_at.txt"

if [[ "$phase" == "implementing" ]]; then
  printf 'pilot ok\n' > "$repo/NOTES.md"
  printf 'IMPL %s no-cost\n' "$ticket" > "$out/IMPL_DONE.txt"
  printf 'status=ok\nphase=implementing\nbuilder_pid=%s\nartifact=NOTES.md\n' "$pid" > "$out/outcome.txt"
else
  mkdir -p "$out"
  cat > "$out/PLAN.md" <<EOF
# PLAN $ticket

No-cost disposable plan. Write one line to NOTES.md.
Verify with the ticket verify command.
SAFE_POLICY_CLASS
EOF
  printf 'status=ok\nphase=planning\nbuilder_pid=%s\nartifact=PLAN.md present\n' "$pid" > "$out/outcome.txt"
fi

date -Iseconds > "$out/finished_at.txt"
echo "ok ticket=$ticket worker=no-cost phase=$phase builder_pid=$pid supervisor_pid=$pid out=$out"
exit 0
