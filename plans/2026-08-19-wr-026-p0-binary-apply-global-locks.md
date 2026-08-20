# WR-026 plan — binary-safe apply + global writer/land authority

**Ticket:** `issues/WR-026-p0-binary-apply-global-locks.md`  
**Forge mirror:** `crawmak/tmp/workers/WR-026/PLAN.md`  
**Verify:** `npm test && npm run quality`  
**This ticket's closeout:** `land: commit`  
**Author:** `JCraw <4335668+jcraw@users.noreply.github.com>` + push `origin`

Status: APPROVED by Jason — 2026-08-20

PLAN ONLY. No product code in this turn. Do not alter the existing untracked `scripts/cleanup-scratch.sh`.

## 1. Goal

Fix both P0 review findings without widening Wave Runner's autonomy:

1. Applying worktree output to a dirty primary must preserve arbitrary file bytes and fail closed on unmergeable binary conflicts.
2. Writer-scope and repository land locks must be authoritative across every supervised CLI/drain process, not merely inside one wave database.

Keep the useful behavior: immutable waves, fresh PLAN/IMPL sessions, parallel PLAN, concurrent disjoint-scope IMPL, text three-way merges, no stash, and terminal proof.

## 2. Reproduced facts

| # | Fact | Consequence |
|---|---|---|
| F1 | `blobAt`, `readIfFile`, and `writeWorkdirFile` use UTF-8 strings. Probe: wanted `00ff0304810a`; apply returned `ok:true` with `00efbfbd0304efbfbd0a`. | Verified binary assets can silently corrupt. |
| F2 | `wave-operator.sh` passes `--db "$OUT_DIR/wave.sqlite"`; parallel lanes use distinct `OUT_DIR`s. | Identical lease keys coexist in separate SQLite files. |
| F3 | CLI controllers use constant holder/process identity strings. | Moving leases into one store without identity work would make different waves look like one claimant. |
| F4 | `finalizeImplLand` marks a ticket failed immediately when the land lock is held. | A real global land lock would turn normal contention into false failure unless closeout becomes retryable. |
| F5 | `enqueueLand` is an in-memory promise tail. | It serializes one Node process only and cannot be the cross-process authority. |

## 3. Decisions

### Binary-safe apply

1. Apply internals operate on `Buffer`, never decoded strings, for blob/file reads, equality, direct copy, add, and delete.
2. A deterministic `isMergeableText(Buffer)` requires valid UTF-8 round-trip and no NUL byte. Three-way merge is allowed only when base/ours/theirs that exist are mergeable text.
3. One-sided changes are byte copies/deletes regardless of type. This covers binary add/update/delete without invoking `git merge-file`.
4. If both primary and incoming changed a non-text path, return `APPLY_BINARY_CONFLICT: <path>`, leave that primary path byte-for-byte unchanged, keep the worktree, and never report DONE.
5. Existing text conflict-marker behavior remains unchanged. The proof differentiates `conflicts` and `binaryConflicts` while keeping `ok:false` and `mode:"apply"` compatible.
6. Do not introduce image/media extension lists. Content bytes, not filenames, decide mergeability.

### Cross-wave authority

7. Supervised CLI waves for the same canonical repository share one SQLite ledger at a stable path derived from the canonical Git common directory/repository identity under `WR_SCRATCH/ledgers/`. Fixture/mock CLI may continue to accept explicit isolated `--db` paths.
8. `wave-operator.sh` computes/exports one stable `WAVE_DB` per canonical repository unless the operator explicitly supplies a shared path. `run-backlog-wave.sh`, parallel lanes, and independent drain invocations therefore converge on the same authority.
9. Each wave exports a stable logical `WAVE_RUNNER_OPERATOR_ID` derived from its wave id. `openCliController` uses it as `processIdentity`; it is stable across create/start/tick processes and distinct across waves. Supervised mode fails closed if a safe identity cannot be formed.
10. Keep leases in the existing ledger/schema and reuse SQLite transactions, fencing generation, TTL, and stale expiry. Do not add a second lock-file protocol.
11. Make wave ids collision-resistant (timestamp with nanoseconds or UUID suffix) because a shared ledger makes same-second collisions visible.
12. Land lock contention is `deferred`, not `FAILED`. A VERIFYING ticket with a settled successful IMPL remains eligible for deterministic closeout retry on later ticks. Actual apply/land errors still fail with proof.
13. Add a deterministic `advancePendingCloseouts` step. It finds VERIFYING tickets whose latest IMPL settled successfully, attempts the global land lock, and finalizes idempotently. Settlement may call the same helper for low latency, but a restart/tick must be sufficient.
14. `enqueueLand` may remain a local optimization but is not named or tested as the authority. The shared lease is authoritative.

### Approved review conditions

15. Preserve `APPLY_BINARY_CONFLICT` through `src/core/apply-closeout.ts`; do not relabel it as `APPLY_CONFLICT`.
16. Treat land-lock `hold` as acquired/refresh for the same operator. Only `deny` defers. A deferred closeout keeps its writer lease while VERIFYING.
17. Use the same canonical repo identity for shared-ledger resolution and writer/land lease keys. Cover symlink and trailing-slash spellings.
18. Closeout retry is idempotent: durable successful `APPLY.json` / `LAND.json` can advance DONE even if the impl worktree was already removed before the status write.
19. VERIFYING with settled successful IMPL awaiting closeout is live operator work and cannot trigger stuck detection.
20. Both-changed non-text includes modify-vs-delete. Binary blob reads must not inherit the default 1 MiB child-process buffer.
21. Supervised `WAVE_DB` uses the existing `WR_SCRATCH` UUID fail-closed contract. Explicit `--db` remains only for fixtures/direct CLI. Plugin state remains separate and the split-authority limitation is documented.
22. `scripts/cleanup-scratch.sh` remains untouched. Document that `WR_SCRATCH/ledgers/` is durable state, how old per-wave DBs are inspected, and the current cleanup follow-up risk.

## 4. Ordered implementation

### P0.1 — Buffer apply primitives

- Convert `blobAt`, workdir reads, equality checks, and writes in `src/adapters/apply-workdir.ts` to `Buffer`.
- Extract small pure helpers for byte equality and mergeable-text classification.
- Preserve file deletion/addition semantics and existing proof paths.
- Raise the blob-read buffer limit so large binary files cannot be mistaken for missing content.

### P0.2 — Binary conflict contract

- Branch before `git merge-file` when both sides changed and any participating blob is non-text.
- Do not write markers into binary paths.
- Extend `ApplyResult` minimally with optional `binaryConflicts` if needed; keep existing consumers compatible.
- Preserve the binary-conflict error class through apply closeout.

### P0.3 — Shared CLI ledger resolution

- Add one tested repository-ledger path resolver using canonical repo/Git-common-dir identity and SHA-256-safe directory naming.
- Reuse that canonical identity for writer and land lease keys.
- Thread `WAVE_DB` through operator/drain scripts.
- Preserve explicit `--db` for fixtures and direct CLI users, but make supervised wrapper defaults global and documented.
- Ensure the directory remains scratch/state, never product Git content.

### P0.4 — Stable distinct operator identity

- Add a validated environment/constructor field for logical operator identity.
- Use wave identity in wrappers; reject empty/unsafe supervised identities.
- Verify sequential CLI invocations for one wave can refresh/release its lease, while another wave cannot impersonate it.

### P0.5 — Retryable global closeout

- Change land-lock acquisition from fail-ticket-on-contention to a typed acquired/deferred result.
- Treat a same-owner `hold` as acquired and keep the writer lease on foreign-owner deferral.
- Add idempotent tick reconciliation for VERIFYING closeouts after restart or contention.
- Ensure proof and worktree removal happen once; DONE remains proof-gated.
- Let durable successful apply/land proof finish status reconciliation without requiring the removed worktree.

### P0.6 — Operator simplification and docs

- Centralize shared-ledger/identity derivation in one helper surface; Bash should pass values, not duplicate lease rules.
- Count pending VERIFYING closeouts as live work in TypeScript and Bash operator predicates.
- Update the runbook with shared-ledger location, recovery, cleanup, and contention semantics.
- Update misleading comments that imply per-wave/in-memory locks are cross-process authority.

## 5. Tests

| Contract | Required assertion |
|---|---|
| binary add | primary bytes exactly equal incoming bytes; `ok:true`; HEAD unchanged |
| binary one-sided update | exact bytes preserved; no replacement characters; DONE-shaped proof |
| binary delete | unchanged primary side permits byte-safe deletion |
| binary both changed | `APPLY_BINARY_CONFLICT`; primary bytes unchanged; worktree kept; not DONE |
| text merge regression | clean 3-way retains both edits |
| text conflict regression | markers remain; `APPLY_CONFLICT`; worktree kept |
| shared store | two wrapper/controller instances for same canonical repo resolve identical DB authority |
| same-scope race | first IMPL lease wins; second remains APPROVED/deferred; no duplicate writer |
| disjoint scopes | both IMPL leases may coexist in the shared database |
| stable identity | same wave across fresh CLI controllers holds/releases; different wave is denied |
| canonical identity | symlink and trailing-slash repo spellings share DB and lease keys |
| land contention | second VERIFYING ticket remains retryable, then DONE after first releases |
| same-owner land hold | refreshed as acquired rather than deferred |
| restart closeout | settled IMPL + process restart + tick completes closeout exactly once |
| post-proof restart | durable successful proof advances DONE with impl worktree already removed |
| stuck detection | pending VERIFYING closeout remains live beyond the normal stuck threshold |
| independent drains | same repo resolver converges even with different `OUT_ROOT`s |
| wave id | concurrent wrapper ids do not collide |

Run focused tests first, then `npm test && npm run quality`. Mutation is optional unless touched pure lease behavior warrants `npm run mutation`.

## 6. Touched set

**Expected:**

- `src/adapters/apply-workdir.ts`
- `src/core/apply-closeout.ts`
- `src/adapters/ports.ts` and/or `src/core/ports.ts`
- `src/runtime.ts`
- `src/core/land-closeout.ts`
- `src/core/tick.ts` or a new small closeout reconciliation module
- `src/core/operator-loop.ts` and corresponding supervised Bash predicates
- canonical repository/lease-key helper modules as required
- `src/domain/types.ts` only if the proof/result contract needs an optional field
- `scripts/wave-operator.sh`
- `scripts/run-backlog-wave.sh`
- `scripts/run-backlog-parallel.sh` only for identity/id generation plumbing
- `docs/OPERATOR-RUNBOOK.md`
- focused tests under `test/`
- WR-026 ticket and this plan closeout fields

**Must not:**

- modify `scripts/cleanup-scratch.sh`
- touch product/jam repositories
- weaken existing apply conflict or lease tests
- use per-extension binary rules
- use a second independent lock authority
- add polling LLM turns, unrestricted drain, stash, deploy, or implicit push

## 7. Risks and controls

| Risk | Control |
|---|---|
| Shared DB grows forever | Keep wave artifacts outside it; document retention/backup; cleanup becomes a follow-up, not an unsafe delete in this ticket. |
| Old per-wave DBs become invisible | Preserve explicit inspection by path and document that new supervised runs use the shared authority. No destructive migration. |
| Lock contention strands VERIFYING | Tick-owned durable closeout reconciliation; test restart and eventual acquisition. |
| Buffer rewrite regresses text merge | Keep existing text tests plus exact-byte and both-changed binary fixtures. |
| Canonical paths differ through symlinks/worktrees | Resolve Git common directory/canonical repo identity before hashing. |

## 8. Completion loop

1. PLAN artifacts only; stop.
2. Crawmak forge-cwd review writes `reviews/WR-025.md`; ticket is then renumbered WR-026 after discovering the historical WR-025 collision; stop.
3. Jason approves the reviewed conditions and stamps this exact plan `APPROVED by Jason`.
4. Fresh IMPL session with this approved plan.
5. `npm test && npm run quality` on current HEAD.
6. Commit under jcraw noreply identity, mark WR-026 done, push origin.

## Learn

- bite: none
- candidate: cross-wave safety requires one cross-wave authority; a lease key has no force when every wave owns a different ledger
- promote: no
