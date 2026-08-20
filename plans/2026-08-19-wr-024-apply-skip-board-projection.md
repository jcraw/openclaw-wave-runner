# WR-024 plan — skip BOARD.md on apply

**Ticket:** `issues/WR-024-apply-skip-board-projection.md`  
**Verify:** `npm test && npm run quality`  
**Live fail:** `BL-20260819155318` MUD-039 `APPLY_CONFLICT: issues/BOARD.md`

**APPROVED by Jason 2026-08-19** (direct: get MUD waves through; this is the land hole after WR-022/023).

## Decisions

| # | Pick |
|---|---|
| D1 | `isBoardProjection(path)` → `(^|/)issues/BOARD.md$` |
| D2 | `applyToWorkdir` 3-way only non-board incoming. Then existing `markBoardDone` + `markIssueDone` on primary. |
| D3 | Product-file conflicts still `APPLY_CONFLICT`. Board-only dirty is success. |
| D4 | Do not take the worktree's whole BOARD rewrite. Keep Jason/other-ticket rows on primary. |

Out: Astra process, Crawmak review, WR-023, SAFETY.
