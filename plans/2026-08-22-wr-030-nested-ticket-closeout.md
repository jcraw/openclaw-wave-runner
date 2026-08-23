# WR-030 plan — nested issue closeout + terminal-wins duplicates

**Ticket:** `issues/WR-030-nested-ticket-closeout.md`  
**Forge mirror:** `crawmak/tmp/workers/WR-030/PLAN.md`  
**Verify:** `npm test && npm run quality`  
**Land:** `commit` + push origin (`env -u GH_TOKEN`). Author `JCraw <4335668+jcraw@users.noreply.github.com>`  
**Review:** skip (mechanical closeout, 3–4 files).

APPROVED by Jason — 2026-08-22 (implement WR-030; do not wait Astra)

No jam edits. No SAFETY flips. Do not invent Astra. Leave live RRT-067 wave alone.

## Goal

One-ticket serial drain: PLAN → IMPL → verify → apply bytes → **nested ticket markdown `status: done`** → next ticket’s dry-run sees the dep as terminal.

Live miss: `drain-rrt-20260822165115` 063 applied product, ledger DONE, file stayed `in_progress`, 064–067 skipped at freeze.

## Decisions

| # | Pick |
|---|---|
| D1 | Keep one-ticket serial waves. Do not pack 062–067 into one wave. |
| D2 | WR closeout owns `status: done`. Do not wait for the worker to set it. |
| D3 | Reuse `listMarkdownTickets` in `markIssueDone`. Match basename `ID.md` or `ID-*.md`. Skip BOARD (walker already does). Return posix paths relative to repo. |
| D4 | Apply order stays: copy product (including issue md) → `markBoardDone` + `markIssueDone` on **primary**. Recurse is enough; do not skip copying issue files. |
| D5 | Duplicate ids: **any terminal wins**. Shared helper used by freeze catalog and eligible-select. Non-terminal vs non-terminal: first kept. |
| D6 | Skip reason: if `dry-run.err` has `missing_dependency`, copy the `Open dependency …` line (clip ~120). Keep existing `missing_verify` branch. |
| D7 | Leave `markBoardDone` regex alone. Freeze uses ticket markdown (WR-016). |
| D8 | `MarkdownTracker.mirror` first-match-only stays out of scope. |

## Changes

1. `src/adapters/land-git.ts` `markIssueDone` — walk `listMarkdownTickets(join(repo,"issues"))`, rewrite frontmatter `status: done` on every matching file. Used by apply and commit-land already; both get the fix.

2. `src/core/manifest.ts` — `mergeCatalogById(entries)` using `TERMINAL_BOARD_STATUSES`. `normalizeSelectedDependencies` merges before `Map`. Export for select.

3. `src/adapters/eligible-select.ts` — merge catalog rows with the same helper (adapt extra fields: if incoming status is terminal, replace the row; if prev is terminal, keep prev). Then existing `depsOk` / skip-terminal logic.

4. `scripts/run-backlog-wave.sh` — parse `missing_dependency` from `cli/dry-run.err` into SKIPPED reason.

5. Runbook: one sentence under apply closeout — `markIssueDone` walks `issues/**`.

## Tests

**`test/wr-022-apply-closeout.test.ts`** (must; today’s fixtures are top-level `issues/FX-101-one.md` only)

- Nested: `issues/remote_root/RRT-063-no-end-screen.md` on primary `status: in_progress`. Worktree copies that file still `in_progress` plus a product path. After `applyToWorkdir`, nested file is `status: done`. HEAD unchanged. `APPLY.json` ok.
- Duplicate leftover: same repo also has `issues/remote_root/RRT-063-old-slug.md` `status: plan_review` (not in incoming). After apply, **both** files `status: done`.

**`test/wr-023-plan-gate.test.ts`** (or wr-022 if cheaper)

- Two files same id: one `done`, one `plan_review`. `selectEligibleTickets` does **not** emit the id. A dependent with `verify` is eligible.
- Reverse walk order (done file first vs last) — both terminal-wins.

**`src/core/manifest.ts` unit** (same test file or tiny new)

- `normalizeSelectedDependencies`: catalog has `RRT-063` twice (`in_progress` then `done`). Selecting `RRT-064` depending on 063 does **not** throw. Reverse order also ok. Two `open` copies still throw `missing_dependency`.

**Skip-reason:** grep `run-backlog-wave.sh` for `missing_dependency` (same style as WR-029 operator-result source assert). Optional: fixture err snippet → expected reason string if a tiny helper is extracted; do not spawn a live dry-run.

## Out of scope

BOARD line format. WR-028. Re-select between tickets. Jam 062–067 files (already hand-closed). Overnight. `timeoutSeconds` spawn debate.

## Learn

- bite: none
- candidate: apply DONE + nested `issues/<board>/ID-*.md` still open → next wave `missing_dependency` → `markIssueDone` must walk `listMarkdownTickets`
- promote: no
