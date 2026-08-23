---
id: WR-032
title: Serial apply commits HEAD; apply-mode fence does not FAIL applied work; dead PID leases; no tick on empty inspect
status: done
priority: crit
created: 2026-08-23
updated: 2026-08-23
source: jason
assignee: crawmak
builder: crawmak
worker: grok
preferred_model: grok
agent_eligible: true
eligibility: done
needs_jason: false
phase: done
labels: [p0, apply, lease, operator, closeout]
depends_on: [WR-030]
related: [WR-019, WR-022, WR-026, WR-028, WR-029]
verify: npm test && npm run quality
verify_command: npm test && npm run quality
worker_out_dir: tmp/workers/WR-032
plan: plans/2026-08-23-wr-032-rrt-halt-apply-commit-lease.md
land: commit
plan_review: skip
---

# WR-032 — Finish the RRT-065/066/067 halt paths

Live serial apply drains copied bytes onto primary and then the next one-ticket wave froze the previous HEAD. RRT-067 IMPL blocked on a 064 SHA while 066 charge files sat uncommitted. RRT-066 APPLY.json was ok and the wave still FAILED `stale_fence: writer lease missing + applied`. A killed operator left a writer lease; resume deleted it and the in-flight ticket fenced. Empty inspect was treated as RUNNING.

## Acceptance

- [x] Successful apply commits the copied paths on primary (identity from land-git). Next `currentHead` is that SHA.
- [x] Apply mode does not fail a worker-succeeded IMPL solely because the writer lease is missing. Verify still runs. Apply success is DONE.
- [x] Writer leases whose `pid` is dead (`ESRCH`) are released on tick. TTL expiry unchanged. Missing pid is not an orphan.
- [x] `wave-operator.sh` loop: empty inspect does not tick; COMPLETED still WAVE_OK without start/tick.
- [x] `npm test && npm run quality`. Commit-land + push origin.

## Non-goals

WR-028 review stage. Packing a chain into one wave. SAFETY / overnight. Inventing Astra.
