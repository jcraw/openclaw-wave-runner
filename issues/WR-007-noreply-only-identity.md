---
id: WR-007
title: Public git identity is noreply-only — scrub personal mailboxes
status: done
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
After the stranger-`jason` rewrite, public `main` authors were set to a **personal mailbox**. That address became git metadata on origin. `docs/GIT-IDENTITY.md` and the identity checker also *recommended* that mailbox.

## Scope
In:
- Jason-gated author rewrite of `main` to `JCraw <4335668+jcraw@users.noreply.github.com>`
- After rewrite: `check-git-identity.mjs` **fails** if any author/committer is a personal mailbox or a non-jcraw noreply
- No personal inbox in docs, scripts, package metadata, or recommended examples
- `npm run identity` / `npm run quality` stay fail-closed

Out:
- Other private repos unless Jason asks
- Overnight / drain
- Changing GitHub account recovery email

## Acceptance
- [x] `git log --format=%ae%n%ce` on origin/main has no personal mailboxes
- [x] Identity check fails closed on a personal mailbox in history
- [x] Docs recommend only the id-prefixed jcraw noreply
- [x] `npm run identity` green after rewrite

## Resolution

**Done 2026-08-14.** Jason-gated `git filter-repo` mailmap + blob replace. Authors are `JCraw <4335668+jcraw@users.noreply.github.com>`, existing `jcraw@users.noreply.github.com`, or machine `astra@openclaw.local`. Local bundle: `~/.openclaw/workspace/tmp/wr-007-rewrite/pre-rewrite.bundle`.
