---
id: WR-011
title: Path-scoped writer leases + parallel multi-product waves
status: done
priority: high
created: 2026-08-15
updated: 2026-08-15
source: jason
agent_eligible: true
eligibility: agent_eligible
depends_on: []
verify: npm test
worker: astra
phase: done
labels: [concurrency, leases, parallel, game-jam]
---

# WR-011 — Path-scoped writer leases

## Problem
Whole-repo `repo-writer:<repo>` serializes Godstones vs Rink Rush vs every other jam in `game_jam`. Multi-game monorepos need parallel writers on **disjoint product paths**.

## Design
1. Derive `writerScope` per ticket from `product` / `game` / `issues/<board>/` / ticket prefix.
2. Lease key = `writer:<repo>:<scope>` (not whole repo).
3. `advanceReadyTickets` admits multiple non-conflicting stages (different scopes; provider cap applies).
4. Supervised default `perProviderConcurrency: 3` so multi-game waves can actually fan out.
5. Parallel backlog driver: one worker lane per scope.

## Acceptance
- [ ] Two tickets different scopes can hold IMPL leases at once (same wave or tests)
- [ ] Same scope still serial on IMPL
- [ ] `npm test` green
- [ ] Parallel driver script exists

## Out
- Unrestricted drain / overnight
- Cross-host distributed locks

## Closeout

Shipped 2026-08-15 dda36b9. npm test 114/114.
