---
id: WR-002
title: Raise pure-core mutation score to 80%
status: open
priority: high
created: 2026-08-14
updated: 2026-08-14
source: jason
agent_eligible: true
eligibility: agent_eligible
depends_on: []
verify: npm run mutation
labels: [quality, mutation]
---

# WR-002 — Mutation 80% on pure core

## Problem
Stryker on `dist/src/core/budget.js`, `lease.js`, `domain/safety.js` measured **70.03%** (2026-08-13). DIGEST-007/025 want ≥80% on core. Break threshold is still 60.

Survivors are mostly untested branches: `summarizeBudgets` arithmetic, USD cost ceiling, `failClosedWithoutRates`, `canAcquire` AND vs OR, safety limit boundary equalities.

## Acceptance
- [ ] `npm run mutation` exit 0 with `thresholds.break` **80**
- [ ] Kill real behavior mutants with tests — do not weaken mutators or exclude ConditionalExpression/BlockStatement to fake the score
- [ ] StringLiteral may stay excluded (error message text)
- [ ] `docs/QUALITY-GATES.md` records the new measured score
- [ ] `npm run quality:fast` still green

## Owning paths
- `test/mutation-core.test.ts` (and new focused tests if needed)
- `stryker.config.json`
- `docs/QUALITY-GATES.md`

## Agent notes
Do not mutate `controller.ts` or adapters in this ticket. Do not lower coverage floors. Public package only.

## Resolution
