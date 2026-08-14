---
id: WR-007
title: Public git identity is noreply-only — scrub personal mailboxes
status: blocked
priority: crit
created: 2026-08-14
updated: 2026-08-14
source: jason
agent_eligible: false
eligibility: human_gated
needs_jason: rewrite
depends_on: []
verify: npm run identity && npm test
labels: [identity, privacy]
---

# WR-007 — Noreply-only public identity

## Problem
After the stranger-`jason` rewrite, public `main` authors were set to a **personal mailbox**. That address is now git metadata on origin. `docs/GIT-IDENTITY.md` and the identity checker also *recommended* that mailbox.

Tree leak (docs/checker copy) is being stripped in the prevent-forward hotfix. **History on origin still has the mailbox** until an explicit author rewrite + force-push.

## Scope
In:
- Jason-gated `git filter-repo` / equivalent author rewrite of `main` to `JCraw <4335668+jcraw@users.noreply.github.com>`
- After rewrite: `check-git-identity.mjs` **fails** if any author/committer is not in the noreply allowlist (`4335668+jcraw`, `jcraw`) plus already-pushed machine `astra@openclaw.local` if we keep those commits
- No personal inbox in docs, scripts, package metadata, or recommended examples
- `npm run identity` / `npm run quality` stay fail-closed

Out:
- Other private repos unless Jason asks
- Overnight / drain / merge of closer-wave worktrees
- Changing GitHub account recovery email

## Acceptance
- [ ] `git log --format=%ae%n%ce` on origin/main has no personal mailboxes
- [ ] Identity check fails closed on a personal mailbox in history
- [ ] Docs recommend only the id-prefixed jcraw noreply
- [ ] `npm run identity` green after rewrite

## Agent notes
Do **not** force-push while WR-CLOSER worktrees are live. Rewrite is Jason-only.
