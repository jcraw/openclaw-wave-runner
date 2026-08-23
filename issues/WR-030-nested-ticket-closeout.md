---
id: WR-030
title: Apply closeout marks nested issue files done; duplicate ids treat terminal as done
status: done
priority: crit
created: 2026-08-22
updated: 2026-08-22
source: jason
assignee: crawmak
builder: crawmak
worker: grok
preferred_model: grok
agent_eligible: true
eligibility: agent_eligible
needs_jason: false
phase: done
labels: [p0, apply, closeout, select, deps]
depends_on: [WR-029]
related: [WR-016, WR-022, WR-024]
verify: npm test && npm run quality
verify_command: npm test && npm run quality
worker_out_dir: tmp/workers/WR-030
plan: plans/2026-08-22-wr-030-nested-ticket-closeout.md
land: commit
---

# WR-030 — Nested ticket closeout so the next wave can start

Live: `drain-rrt-20260822165115`. RRT-062/063 `DONE verified+applied`. RRT-064–067 `SKIPPED dry-run failed`.

064 dry-run: `Open dependency RRT-063 (in_progress) for RRT-064 is not selected.` Apply copied `issues/remote_root/RRT-063-no-end-screen.md` (worker left `status: in_progress`). `markIssueDone` only reads top-level `issues/*.md`, so the file never flipped. Next one-ticket wave re-reads markdown and dies.

Jason hand-closed the jam tickets. This ticket is so the next nested-board drain does not stall the same way.

## Acceptance

- [x] `markIssueDone` walks `issues/**` (same as `listMarkdownTickets`). After apply, every `issues/**/<id>-*.md` / `<id>.md` on primary is `status: done`, even if the worker left `in_progress`. BOARD skipped.
- [x] Duplicate id: if any copy is terminal (`done`/`closed`/…), freeze + select treat the id as terminal.
- [x] Preflight SKIPPED reason for this class is `missing_dependency …`, not generic `dry-run failed`.
- [x] Tests cover nested path + leftover duplicate. `npm test && npm run quality`. Commit-land + push origin.

## Out of scope

`markBoardDone` regex. Packing a chain into one wave. WR-028 review-stage. Re-select between tickets. Jam ticket edits.
