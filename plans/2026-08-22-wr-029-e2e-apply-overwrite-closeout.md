# WR-029 plan — apply overwrite + honest closeout

**Ticket:** `issues/WR-029-e2e-apply-overwrite-closeout.md`  
**Verify:** `npm test && npm run quality`  
**Land:** commit + `WAVE_LAND_PUSH` via `env -u GH_TOKEN` in land-git

APPROVED by Jason — 2026-08-22 (implement these five; do not wait Astra)

## Goal

Supervised wave: PLAN → IMPL → verify → **files in the project folder** → ticket DONE + `WAVE_RESULT.json`.

## Changes

1. `applyOnePath`: incoming add/update/delete copies or unlinks. No 3-way. BOARD skip unchanged.
2. `git push origin` with `GH_TOKEN` deleted from env.
3. Select statuses: `open|in_progress|todo|ready|plan_review|planning|implementing|""`.
4. ACP `sessions_spawn` `timeoutSeconds` = stage wall (`WAVE_*_WALL_MS`; 0 → 7 days).
5. `wave-operator.sh` writes `WAVE_RESULT.json` on COMPLETED/FAILED/hold/stuck.

## Out of scope

WR-028 review-stage + Astra stamp wait. SAFETY. Overnight.

## Learn

- bite: none
- candidate: jam apply 3-way vs dirty primary → overwrite incoming
- promote: no
