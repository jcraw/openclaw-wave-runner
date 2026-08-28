---
id: WR-036
title: Apply skips out-of-scope dirty paths; BOARD stamp matches house rows
status: done
priority: high
created: 2026-08-27
updated: 2026-08-27
source: jason
assignee: crawmak
builder: crawmak
worker: grok
preferred_model: grok
agent_eligible: true
eligibility: done
needs_jason: false
phase: done
labels: [apply, board, writer-scope, closeout]
depends_on: [WR-024, WR-032]
related: [WR-011, WR-016]
verify: npm test
verify_command: npm test
worker_out_dir: tmp/workers/WR-036
land: commit
plan_review: skip
---

# WR-036 — Apply scope + house BOARD stamp

SP2-031 apply committed a Godot `android/build` template dump because apply copies every dirty worktree path. `writerScope` only gated leases. `markBoardDone` looked for `- **ID open**` and missed house rows `- **ID open · hybrid · high**`; missing rows were a silent no-op.

## Acceptance

- [x] Apply with a game/jam writerScope copies only those prefixes plus `issues/<game>/` and that ticket's `issues/**/ID*.md`. Extra dirty paths are skipped and listed on `APPLY.json.skipped`. Land still succeeds.
- [x] No writerScope prefixes (legacy `prefix:` / unset) still copies all non-BOARD incoming (existing tests).
- [x] `markBoardDone` stamps `open` → `done` on house rows and strips leftover `not kicked`. Missing row does not fail land.
- [x] `npm test`

## Non-goals

Auto-insert BOARD rows. Android overlay restore (game_jam). Samsung. Fail land on extra dirty paths.

## Learn

- bite: other:apply-unscoped-plus-board-regex
- candidate: writerScope leases ≠ apply path filter; BOARD regex required `open**` and never matched `open · hybrid`
- promote: no
