# ADR-001 — Independent frozen-wave authority with optional Workboard projection

- **Status:** accepted for M0/v0
- **Date:** 2026-08-12
- **Decision:** B — independent tracker adapter; Workboard is an optional source/projection, never frozen-wave authority

## Context

M0 had to establish whether the bundled Workboard can safely supply cards,
dependencies, claims, and completion events without requiring Wave Runner to
query or modify OpenClaw/Workboard database tables.

Authoritative local OpenClaw documentation and shipped public contracts show:

- Workboard exposes cards, dependency links, claims/heartbeats, attempts,
  task/run/session links, proof/artifacts, diagnostics, and replay-safe
  notification cursors through agent tools and `workboard.*` Gateway RPC.
- Workboard dispatch owns a mutable operating queue and starts normal native
  subagent sessions. It intentionally promotes dependencies, repairs stale
  claims, limits a dispatch batch, and synchronizes card state with sessions.
- Workboard stores state in its own relational SQLite database, but that
  database is an implementation detail. The Wave Runner must use tools or RPC,
  never Workboard tables.
- Managed Task Flow provides durable flow JSON, linked tasks, revision-checked
  transitions, durable wait state, sticky cancellation, and restart survival.

The mutable queue semantics are useful operationally but are not an immutable
execution manifest. Workboard has no public transaction that atomically freezes
an arbitrary selected card subgraph together with a repository base SHA and
wave budget. Making its live cards authoritative would allow later card edits,
dependency promotion, reassignment, or claim recovery to change admitted work.

## Decision

Wave Runner owns the immutable manifest and budget/outbox records. A tracker
adapter may read explicitly selected Workboard cards and dependencies using
public tools/RPC, normalize them, and hash the resulting snapshot. After that
freeze, execution reads only the frozen records.

Workboard may remain:

1. an **optional selection source** for cards/dependencies;
2. an **optional claim signal** during pre-freeze admission;
3. a **post-commit projection** of wave/task state; and
4. a **replay-safe completion/event source** for Workboard-owned work.

Workboard is not authoritative for the frozen wave, budget, launch idempotency,
or repository writer lease. Wave Runner does not invoke Workboard dispatch for
wave child execution; native Task Flow/subagent APIs own that path.

## M0 evidence

- The plugin uses only `api.runtime.tasks.managedFlows`, read-only Task Run
  DTOs, and `api.runtime.subagent`.
- The deterministic harness proves revision-bound wait/resume, restart state,
  one child launch, task linkage, and sticky cancellation.
- The Workboard experiment is documentation/API-contract based and disabled:
  M0 neither enables Workboard nor creates cards. This avoids Gateway config
  changes and production board mutation while still resolving composition.
- Public Task Run DTOs expose task/run/session ids and lifecycle but not
  authoritative provider response ids or token usage. M0 therefore records
  usage as unavailable; later budget code must retain the full reservation as
  `INDETERMINATE` unless another supported public usage contract is proven.

## Consequences

### Positive

- Immutable waves cannot drift with mutable cards.
- Workboard remains reusable for operator UX without coupling Wave Runner to
  its storage internals or dispatch policy.
- The implementation can begin with Markdown and add Workboard as another
  adapter behind the same frozen manifest contract.

### Costs

- A small amount of card/dependency data is duplicated in the frozen snapshot.
- Projection requires idempotent post-commit writes and visible retry status.
- Workboard claims cannot substitute for Wave Runner's later repository lease
  and fencing protocol.

## Rejected alternatives

- **Workboard as frozen-wave authority:** rejected because its public contract
  is mutable operating state, not an atomic immutable wave snapshot.
- **Direct Workboard/OpenClaw SQLite reads:** rejected as unsupported and
  explicitly prohibited.
- **Reimplement Workboard queue/card functionality:** rejected; its public
  tools/RPC already provide sufficient optional source/projection seams.
