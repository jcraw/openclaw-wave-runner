---
id: WR-017
title: Investigate + fix Wave Runner git land/closeout reliability
status: done
priority: high
created: 2026-08-16
updated: 2026-08-16
source: jason
agent_eligible: true
eligibility: agent_eligible
depends_on: []
verify: npm run quality
labels: [closeout, git, land, identity, worktree]
---

# WR-017 — Land/closeout reliability

## Problem
WR-013 shipped land-on-done. WR-018 extracted it and fixed the push heuristic. Land still
invents `wave-runner@local`, can mark DONE without durable `LAND.json`, leaves impl
worktrees registered after a successful land, and stashes the primary checkout (merge/stash
races). Failed push after merge can look like a clean miss.

## Goal
A verified IMPL is not DONE until product changes are on primary `main` with a durable
land proof. Land commits use the repo identity (or explicit `WAVE_LAND_*`). Failed land
must not look like success. Worktrees must not hang after a successful land.

## Acceptance
- [ ] Land commits never invent `wave-runner@local`; author is repo config or `WAVE_LAND_*`
- [ ] DONE only when `land.ok` and durable `tmp/wave-runner/<wave>/<ticket>/LAND.json` exists
- [ ] Missing `landToMain` or missing impl worktree → FAILED `/land failed/`, not DONE
- [ ] Successful land removes the impl worktree; proof remains on the durable path
- [ ] Failed land keeps the worktree registered
- [ ] No stash; overlapping primary dirt fails closed; unrelated dirt survives
- [ ] Push failure keeps `commitSha` and does not mark DONE
- [ ] Writer lease is held through land; `land:${repoPath}` serializes closeout
- [ ] `shouldLandPush({}) === false` (no WR-018 regression)
- [ ] `npm test` 0; closeout `npm run quality` 0

## Out of scope
`WAVE_LAND_PUSH` heuristic, `SAFETY` flips, Gateway/plugin id, Stryker mutate set,
multi-ticket chain land (WR-006), board-dep truth (WR-016).
