---
id: WR-001
title: Split core/controller.ts under token ceiling
status: done
priority: high
created: 2026-08-14
updated: 2026-08-14
source: jason
agent_eligible: true
eligibility: agent_eligible
depends_on: []
verify: npm run quality:fast && npm run tokens
labels: [quality, cohesion]
---

# WR-001 — Split core/controller.ts

## Problem
`src/core/controller.ts` is ~1326 lines / ~11.7k tokens (DIGEST-007 error ceiling is 2500). It is the composition root and a coordinator dump. Quality review 2026-08-13 baselined it; do not keep the waiver.

## Acceptance
- [ ] `src/core/controller.ts` at or under 2500 tokens (chars/4) or removed; `config/token-baseline.json` no longer allows 12000 for it
- [ ] Extracted modules stay under 2500 tokens each; no new file over the error ceiling
- [ ] `src/core/**` still does not import adapters except the documented composition-root leak (`stage-artifacts`, `ports`) — prefer moving those deps out of `core/` if cheap
- [ ] Existing behavior preserved: freeze, admit, outbox, leases, approve, cancel, supervised caps
- [ ] `npm run quality:fast` green and `npm run tokens` exit 0

## Owning paths
- `src/core/controller.ts`
- `src/core/*` (new modules)
- `config/token-baseline.json`
- `docs/QUALITY-GATES.md` (baseline note)

## Agent notes
Do not enable overnight/drain. Do not weaken tests. Do not rewrite adapters. Public package only.

## Resolution
Landed 2026-08-14 as `0a04942`. `controller.ts` facade **1063** tokens; extracted admission/launch/tick/settlement/wave-*. Verify: `npm run quality:fast && npm run tokens`.
