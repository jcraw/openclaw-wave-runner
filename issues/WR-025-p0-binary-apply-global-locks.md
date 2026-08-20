---
id: WR-025
title: Binary-safe apply and cross-wave writer/land authority
status: done
priority: crit
created: 2026-08-19
updated: 2026-08-19
source: jason
assignee: crawmak
builder: crawmak
worker: grok
preferred_model: grok
agent_eligible: true
eligibility: agent_eligible
needs_jason: false
phase: planning
labels: [p0, apply, binary, concurrency, lease, land]
depends_on: []
related: [WR-011, WR-017, WR-022, WR-024]
verify: npm test && npm run quality
verify_command: npm test && npm run quality
worker_out_dir: tmp/workers/WR-025
plan: plans/2026-08-19-wr-025-p0-binary-apply-global-locks.md
land: commit
---

# WR-025 — Binary-safe apply and cross-wave writer/land authority

Jason requested fixes for the two P0 findings from the 2026-08-19 deep Wave Runner review.

## Problem

1. `applyToWorkdir` reads and writes every file as UTF-8. A verified binary input can be corrupted while `APPLY.json` reports `ok: true`.
2. CLI/drain waves keep one SQLite ledger per `OUT_DIR`. Writer and land leases in different databases cannot fence one another, while `run-backlog-parallel.sh` intentionally runs multiple waves against the same primary repository.

## Acceptance

- [ ] Binary add/change/delete fast paths preserve exact bytes.
- [ ] A one-sided binary change applies successfully without changing primary `HEAD`.
- [ ] Concurrent binary edits fail closed without modifying the primary binary or deleting the worktree.
- [ ] Text three-way merge and conflict-marker behavior remain green.
- [ ] All supervised CLI waves for one canonical repository use one shared durable lease authority.
- [ ] Different waves use distinct stable logical operator identities across their separate CLI invocations.
- [ ] Same repo + same writer scope cannot hold two live IMPL leases across processes/databases.
- [ ] Different writer scopes may still IMPL concurrently.
- [ ] Land/apply closeout is globally serialized per repository; lock contention waits/retries instead of failing finished work.
- [ ] Existing single-wave ledgers remain inspectable or receive a documented migration/compatibility path.
- [ ] `npm test && npm run quality` exits 0; WR-025 commit-lands and pushes `origin`.

## Non-goals

- Token-budget, provider-cap, wall-time, or idempotent-create P1/P2 findings.
- Changing apply-versus-commit policy.
- Enabling unrestricted or autonomous drain.
- Stashing, overwriting, or committing Jason's dirty product worktree.

