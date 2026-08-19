---
id: WR-022
title: Apply closeout into dirty primary + verify FIX loop
status: done
priority: crit
created: 2026-08-18
updated: 2026-08-19
source: jason
assignee: crawmak
builder: crawmak
worker: grok
preferred_model: grok
agent_eligible: true
eligibility: agent_eligible
needs_jason: false
phase: done
labels: [p0, closeout, apply, verify, fix, land]
depends_on: []
related: [WR-013, WR-017, WR-021, WR-010]
verify: npm test && npm run quality
verify_command: npm test && npm run quality
worker_out_dir: tmp/workers/WR-022
plan: plans/2026-08-18-wr-022-apply-closeout-and-verify-fix.md
land: commit
---

# WR-022 — Put finished work in the working tree; FIX failed verify

Jason (2026-08-18): game_jam is one dirty working tree. Other agents work in parallel. **Done means the files are back in that folder, uncommitted.** He commits later. Work left only in a worktree is not done.

`commit` closeout (today’s land-on-done) stays for repos/tickets he directs — Wave Runner itself, anything with `land: commit` / `WAVE_LAND_MODE=commit`. Do not undo that.

If path-verify fails, the process **fixes the gates**. Blind IMPL retry then FAILED is not enough.

## Problem

1. **Closeout mismatch.** WR-013 “land” = git-commit onto `main`. Dirty overlap (WR-017/021) fail-closes and strands a green worktree. Jason never asked for a commit on jam. He asked for the bytes in `game_jam/`.
2. **Preflight fights apply.** WR-021 refuses PLAN/IMPL when the desk is dirty. That is correct for commit-land. It is wrong for apply-closeout.
3. **Verify die.** Controller `product_verify` rearms IMPL (WR-010) without the verify body. RR-073 retried and still died. No FIX brief.

## Goals

1. Closeout mode `apply` | `commit`. `commit` = current `landToMain` (proof, push flag, identity, no stash).
2. `apply`: copy verified tip into the **primary working tree**, no commit, then DONE (or FAILED-with-files-in-tree on conflict / exhausted verify).
3. Mode pick: ticket `land:` / `land_mode:` → `WAVE_LAND_MODE` → default `commit` (WR self-drains stay commit unless told).
4. Jam drain sets `WAVE_LAND_MODE=apply` unless already set.
5. `apply` does not fail-closed on dirty overlap at admit/PLAN/IMPL.
6. `product_verify` fail → FIX-shaped IMPL retry whose brief includes `WAVE_VERIFY.json`. After retries: apply-mode still puts files in the tree; commit-mode still does not commit red code.
7. `npm test && npm run quality` green; land **commit** this ticket on WR `main` and push origin.

## Non-goals

- Silent stash / overwrite Jason’s same-file edits without a 3-way attempt
- Flipping SAFETY, overnight, or path-based push
- Removing worktrees during IMPL
- Remote Root / Rink Rush product
- New `TicketStatus` values if a `result` prefix + `APPLY.json` is enough

## Acceptance

- [x] Plan stamped (`APPROVED by Astra` or `APPROVED by Jason`)
- [x] Fixture: dirty primary + disjoint incoming → apply writes files, **no new commit**, ticket DONE, `APPLY.json` ok
- [x] Fixture: same-file dirty vs tip → 3-way into workdir; conflict → files present, not silent overwrite, not DONE
- [x] Fixture: `land: commit` / `WAVE_LAND_MODE=commit` still commit-lands (WR-013 tests stay green)
- [x] Apply mode: dirty scope does not refuse PLAN/IMPL; commit mode still does
- [x] product_verify fail: next IMPL brief contains command + verify output; retries then apply-mode copies worktree into primary
- [x] `npm test && npm run quality` 0; pushed; this ticket `land: commit`
