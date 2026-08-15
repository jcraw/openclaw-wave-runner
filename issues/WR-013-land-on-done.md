---
id: WR-013
title: Land-on-done — verified worktree must land main + mark board done
status: done
priority: high
created: 2026-08-15
updated: 2026-08-15
source: jason
agent_eligible: true
eligibility: agent_eligible
depends_on: []
verify: npm test
labels: [closeout, git, land, board]
---

# WR-013 — Land-on-done

## Problem
Waves complete in isolated worktrees and leave primary untouched. Playtest/board lag. Jason: worktrees OK for isolation; **never hang** — put it back on main.

## Goal
On IMPL verify success: land product changes onto repo `main` (commit when autonomous policy allows), mark ticket done on markdown board, record land proof.

## Scope
1. Closeout step after IMPL verified DONE:
   - collect worktree diff vs baseSha
   - apply/commit onto primary main (or merge worktree branch)
   - game_jam: commit OK when WR autonomous; no push unless repo policy says so
   - openclaw-wave-runner: commit + push origin (standing)
2. Mark issue markdown `status: done` + BOARD lines when present
3. Worker prompts: still isolate during build; closeout is controller/operator not worker freestyle merge
4. Failure to land → ticket not silently DONE (FAILED or BLOCKED with reason)
5. Tests with disposable git fixture

Out: multi-ticket chain (WR-006 already), overnight drain CLI

## Acceptance
- [ ] Verified ticket leaves durable main commit (fixture test)
- [ ] Board/ticket status done
- [ ] No hanging “COMPLETED” worktree-only default path
- [ ] `npm test` green
