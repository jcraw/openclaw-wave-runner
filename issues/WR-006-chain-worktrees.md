---
id: WR-006
title: Chain worktrees — commit-on-verify, successor uses predecessor SHA
status: open
priority: high
created: 2026-08-14
updated: 2026-08-14
source: jason
agent_eligible: true
eligibility: agent_eligible
depends_on: []
verify: npm test
labels: [closer, workspace]
---

# WR-006 — Chain via commit-on-verify

## Problem
Every IMPL worktree is created from frozen `wave.baseSha`. Serial tickets (004→005→006) cannot see each other’s files unless a worker copies by hand. Isolated + no merge means a “DONE” ticket is invisible to the next one. That makes multi-ticket product waves fake.

## Scope
In:
- After IMPL verify **ok**, commit the isolated worktree on `wave/<waveId>/<ticketId>` (local commit only). Record that SHA on the ticket
- When creating the next ticket’s worktree, if it has in-wave `dependsOn` and those deps are `DONE` with a recorded SHA, `git worktree add` from the **latest dependency SHA in wave order**, not `wave.baseSha`
- No `git push`. Do not merge to the primary checkout. Primary stays untouched
- Linear chains only for v0: if a ticket has multiple in-wave deps, use the last `DONE` dep in manifest order
- Tests: ticket B worktree contains ticket A’s committed file; primary HEAD unchanged; verify-fail does **not** commit

Out:
- Merge / push / promote-to-main
- Rebase / conflict resolution UI
- Pack/export format besides the git branch + recorded SHA
- Overnight / drain
- Changing verify commands

## Acceptance
- [ ] `WorkspaceAdapter` can commit a verified worktree and return the SHA
- [ ] `createImplWorktree` accepts the predecessor SHA (spec field or `baseSha` already)
- [ ] Controller/launch uses predecessor SHA for a dependent ticket
- [ ] Verify-fail leaves no success commit
- [ ] `npm test` green (mock workspace is enough plus one git-workspace test if cheap)

## Owning paths
- `src/core/ports.ts` (`WorktreeSpec` / `WorkspaceAdapter`)
- `src/adapters/workspace.ts`
- `src/core/launch.ts` (worktree create)
- `src/core/settlement.ts` (commit after verify ok)
- `src/domain/types.ts` (record `implSha` on ticket)
- `test/`

## Agent notes
Commit identity must be the existing repo author, not a guessed noreply. Do not `git add` secrets or `tmp/wave-runs/**` if a cheap exclude is obvious; product files in the worktree are the point. Public package only.
