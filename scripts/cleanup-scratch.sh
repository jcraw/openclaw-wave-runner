#!/usr/bin/env bash
# Prune Wave Runner scratch so the 7.3T data disk does not fill with old worktrees.
#
# Default is dry-run. Pass --apply to delete.
#
# Keeps:
#   - README.md
#   - the newest KEEP_NEWEST top-level entries (default 3)
#   - anything newer than KEEP_DAYS (default 14)
#   - a dir whose wave.sqlite is still live AND recently touched (LIVE_GRACE_HOURS, default 48)
#
# Usage:
#   ./scripts/cleanup-scratch.sh
#   ./scripts/cleanup-scratch.sh --apply
#   KEEP_DAYS=7 KEEP_NEWEST=2 ./scripts/cleanup-scratch.sh --apply
set -euo pipefail

SCRATCH="${WR_SCRATCH:-/run/media/j/866e11e8-6c31-4c0c-a07c-704845033900/ai/wave-runner}"
KEEP_DAYS="${KEEP_DAYS:-14}"
KEEP_NEWEST="${KEEP_NEWEST:-3}"
LIVE_GRACE_HOURS="${LIVE_GRACE_HOURS:-48}"
APPLY=0
EXPECTED_UUID="866e11e8-6c31-4c0c-a07c-704845033900"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --dry-run) APPLY=0; shift ;;
    --scratch) SCRATCH="${2:?}"; shift 2 ;;
    --keep-days) KEEP_DAYS="${2:?}"; shift 2 ;;
    --keep-newest) KEEP_NEWEST="${2:?}"; shift 2 ;;
    -h|--help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *)
      echo "error: unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

_scratch_uuid="$(findmnt -n -o UUID -T "$SCRATCH" 2>/dev/null || true)"
if [[ "$_scratch_uuid" != "$EXPECTED_UUID" ]]; then
  echo "error: scratch is not on the 7.3T data disk (unmounted or wrong UUID): $SCRATCH" >&2
  exit 1
fi
if [[ ! -d "$SCRATCH" ]]; then
  echo "error: scratch dir missing: $SCRATCH" >&2
  exit 1
fi

export SCRATCH KEEP_DAYS KEEP_NEWEST LIVE_GRACE_HOURS APPLY
python3 - <<'PY'
import os, shutil, sqlite3, sys, time
from pathlib import Path

root = Path(os.environ["SCRATCH"])
keep_days = int(os.environ["KEEP_DAYS"])
keep_newest = int(os.environ["KEEP_NEWEST"])
grace_s = int(os.environ["LIVE_GRACE_HOURS"]) * 3600
apply = os.environ["APPLY"] == "1"
now = time.time()
cutoff = now - keep_days * 86400
live_statuses = {
    "RUNNING",
    "AWAITING_PLAN_GATE",
    "WAITING_APPROVAL",
    "LAUNCHING",
}
protected_names = {"README.md", "cleanup.log", "ledgers"}

def mtime(p: Path) -> float:
    try:
        return p.stat().st_mtime
    except OSError:
        return 0.0

def live_reason(p: Path) -> str | None:
    if not p.is_dir():
        return None
    newest_live = 0.0
    found = None
    for db in p.rglob("wave.sqlite"):
        try:
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if "waves" not in tables:
                con.close()
                continue
            rows = list(con.execute("SELECT wave_id, status FROM waves"))
            con.close()
        except Exception:
            continue
        for wid, st in rows:
            if str(st).upper() in live_statuses:
                db_m = mtime(db)
                if db_m > newest_live:
                    newest_live = db_m
                    found = f"{wid}={st}"
    if found and (now - newest_live) <= grace_s:
        age_h = (now - newest_live) / 3600
        return f"live {found} touched {age_h:.1f}h ago"
    return None

entries = [p for p in root.iterdir() if p.name not in protected_names]
entries.sort(key=mtime, reverse=True)
newest = {p.name for p in entries[:keep_newest]}

keep, delete = [], []
for p in entries:
    age_d = (now - mtime(p)) / 86400
    reasons = []
    if p.name in newest:
        reasons.append(f"newest-{keep_newest}")
    if mtime(p) >= cutoff:
        reasons.append(f"newer-than-{keep_days}d")
    live = live_reason(p)
    if live:
        reasons.append(live)
    rec = (p, age_d, reasons)
    if reasons:
        keep.append(rec)
    else:
        delete.append(rec)

mode = "APPLY" if apply else "DRY-RUN"
print(f"[{mode}] scratch={root}")
print(f"[{mode}] keep_days={keep_days} keep_newest={keep_newest} live_grace_h={grace_s/3600:.0f}")
print(f"[{mode}] keep={len(keep)} delete={len(delete)}")
for p, age_d, reasons in keep:
    print(f"  KEEP  {age_d:5.1f}d  {p.name}  ({', '.join(reasons)})")
bytes_freed = 0
for p, age_d, _ in delete:
    print(f"  DEL   {age_d:5.1f}d  {p.name}")
    if apply:
        if p.is_dir():
            shutil.rmtree(p)
        else:
            p.unlink()

log = root / "cleanup.log"
line = (
    f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')} {mode} "
    f"keep={len(keep)} delete={len(delete)} keep_days={keep_days}\n"
)
with log.open("a") as fh:
    fh.write(line)
if apply:
    print(f"[{mode}] deleted {len(delete)} entries; log={log}")
else:
    print(f"[{mode}] no deletes; rerun with --apply to prune. log={log}")
PY
