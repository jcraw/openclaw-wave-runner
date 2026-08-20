---
id: WR-026
title: Binary-safe apply and cross-wave writer/land authority
status: done
priority: crit
created: 2026-08-19
updated: 2026-08-20
source: jason
assignee: crawmak
builder: crawmak
worker: grok
preferred_model: grok
agent_eligible: true
eligibility: agent_eligible
needs_jason: false
phase: impl
labels: [p0, apply, binary, concurrency, lease, land]
depends_on: []
related: [WR-011, WR-017, WR-022, WR-024]
verify: npm test && npm run quality
verify_command: npm test && npm run quality
worker_out_dir: tmp/workers/WR-026
worker_pid: "704940"
plan: plans/2026-08-19-wr-026-p0-binary-apply-global-locks.md
land: commit
---

# WR-026 — Binary-safe apply and cross-wave writer/land authority

Jason requested fixes for the two P0 findings from the 2026-08-19 deep Wave Runner review.

## Problem

1. `applyToWorkdir` reads and writes every file as UTF-8. A verified binary input can be corrupted while `APPLY.json` reports `ok: true`.
2. CLI/drain waves keep one SQLite ledger per `OUT_DIR`. Writer and land leases in different databases cannot fence one another, while `run-backlog-parallel.sh` intentionally runs multiple waves against the same primary repository.

## Acceptance

- [x] Binary add/change/delete fast paths preserve exact bytes.
- [x] A one-sided binary change applies successfully without changing primary `HEAD`.
- [x] Concurrent binary edits fail closed without modifying the primary binary or deleting the worktree.
- [x] Text three-way merge and conflict-marker behavior remain green.
- [x] All supervised CLI waves for one canonical repository use one shared durable lease authority.
- [x] Different waves use distinct stable logical operator identities across their separate CLI invocations.
- [x] Same repo + same writer scope cannot hold two live IMPL leases across processes/databases.
- [x] Different writer scopes may still IMPL concurrently.
- [x] Land/apply closeout is globally serialized per repository; lock contention waits/retries instead of failing finished work.
- [x] Existing single-wave ledgers remain inspectable or receive a documented migration/compatibility path.
- [x] `APPLY_BINARY_CONFLICT` survives closeout without being rewritten as a text conflict.
- [x] Canonical repo identity is used for both the shared ledger and lease keys, including symlink/trailing-slash paths.
- [x] A same-owner land-lock `hold` refreshes; a foreign-owner `deny` defers without releasing the writer lease.
- [x] Restart closeout is idempotent after durable successful apply/land proof, even when the impl worktree is already gone.
- [x] VERIFYING closeout waits count as live work and do not trip operator stuck detection.
- [x] `npm test && npm run quality` exits 0; WR-026 commit-lands and pushes `origin`.

## Non-goals

- Token-budget, provider-cap, wall-time, or idempotent-create P1/P2 findings.
- Changing apply-versus-commit policy.
- Enabling unrestricted or autonomous drain.
- Stashing, overwriting, or committing Jason's dirty product worktree.
