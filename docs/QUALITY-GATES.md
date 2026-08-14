# Wave Runner quality gates

Maps library_of_craw **DIGEST-007** (AI-native gates), **DIGEST-025** (Kotlin port), and **DIGEST-032** (this product’s test bar) onto this TypeScript plugin.

Trust note: 007/025 are still draft pending citation audit. Principles are adopted; Godot/Kotlin tooling is not copied.

## Decision

| Area | Selected | Rejected | Why |
|------|----------|----------|-----|
| Primary metric | Behavior contracts + mutation on **pure core** | Coverage % as DoD | DIGEST-007/025: coverage theater + weak asserts |
| Mutation tool | Stryker on `src/core/{budget,lease,state-machine}.ts` + `src/domain/safety.ts` | Mutate adapters / `controller.ts` day one | Same as PIT-on-pure-modules |
| Start threshold | **70.03% measured** (break 60, raise toward 80) | 80% day-one hard | First Stryker run 2026-08-13; StringLiteral mutants excluded |
| Coverage | Supporting floor only (c8) | Coverage-only green | Catches untested files, not assertion strength |
| Lanes | `quality:fast` / `quality` / `quality:full` | One giant gate every edit | Token + wall-time |
| Feedback | Compact `tmp/dod-summary.json` | Full tsc/c8 dumps in agent context | DIGEST-007 token fit |
| Test edits | Review + mutation non-regression | Silent test weakening | Anti-game |
| Retries | N=3 then stop | Unlimited agent loops | DIGEST-007/025 |

Godot-only gates (ClassDB, NodePath, frame alloc, visual snapshots) do **not** apply. TS stand-ins:

| 007/025 | Wave Runner |
|---------|-------------|
| ClassDB / compileKotlin | `tsc --strict` |
| gdparse / AST | `tsc` + hygiene |
| PIT STRONGER | Stryker on pure core |
| Konsist | `scripts/check-architecture.mjs` |
| Detekt | hygiene + token ceilings |
| Token / file ceilings | `scripts/check-tokens.mjs` (baseline oversized files) |
| Test lock | PR checklist + mutation |
| DoD JSON | `scripts/dod-summary.mjs` |
| Scene contracts | Domain invariants + PLAN.md matrix tests |

## Lanes

| Lane | Command | Intent |
|------|---------|--------|
| Fast | `npm run quality:fast` | Ticket iteration: typecheck + tests |
| Core | `npm run quality` | PR/CI: hygiene + arch + tokens + coverage + proof + pack + DoD |
| Full | `npm run quality:full` | Release / nightly: core + Stryker |

## DoD (machine JSON)

`npm run dod` writes `tmp/dod-summary.json`. A change is not “quality-green” unless:

- `typecheck` = 0
- `tests_fail` = 0
- `hygiene` = 0
- `architecture` = 0
- `token_new_errors` = 0
- coverage floors hold (`c8.config.json`)
- on full lane: mutation ≥ configured threshold on pure core

Never mark done on coverage alone. Never weaken tests to pass mutation.

## Oversized files (token baseline)

`core/controller.ts` and `store/database.ts` already exceed the 2500-token error ceiling. They are **baselined**, not waived forever. New files and non-baselined growth hard-fail. Split those two before raising the mutation surface to the whole core.

## DIGEST-032 / PLAN.md matrix

See `test/quality-matrix.test.ts` plus the phase1–6 suites. Remaining product gaps (not quality-tooling): overnight plan-approve policy, ACP cancel on emergency-stop, live usage DTO.
