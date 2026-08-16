# Wave Runner quality gates

Maps library_of_craw **DIGEST-007** (AI-native gates), **DIGEST-025** (Kotlin port), and **DIGEST-032** (this product’s test bar) onto this TypeScript plugin.

Trust note: 007/025 are still draft pending citation audit. Principles are adopted; Godot/Kotlin tooling is not copied.

## Decision

| Area | Selected | Rejected | Why |
|------|----------|----------|-----|
| Primary metric | Behavior contracts + mutation on **pure core** | Coverage % as DoD | DIGEST-007/025: coverage theater + weak asserts |
| Mutation tool | Stryker on `src/core/{budget,lease}.ts` + `src/domain/safety.ts` | Mutate adapters / `controller.ts` / `state-machine.ts` in this gate | Same as PIT-on-pure-modules; mutate set matches `stryker.config.json` |
| Start threshold | **90.48% measured** (break 80) | Leaving break at 60 | WR-018 re-run 2026-08-16; StringLiteral mutants excluded |
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
| DoD JSON | `scripts/dod-summary.mjs` (hygiene/arch/tokens/typecheck only) |
| Scene contracts | Domain invariants + PLAN.md matrix tests |

## Lanes

| Lane | Command | Intent |
|------|---------|--------|
| Fast | `npm run quality:fast` | Ticket iteration: typecheck + tests |
| Core | `npm run quality` | PR/CI: hygiene + identity + arch + tokens + typecheck + coverage + proof + pack + DoD |
| Full | `npm run quality:full` | Release / nightly: core + Stryker |

## DoD (machine JSON)

`npm run dod` writes `tmp/dod-summary.json` with typecheck, hygiene, architecture, and token errors. It does **not** run tests or mutation (`tests_fail` / `mutation` stay null).

A change is not “quality-green” unless `npm run quality` exits 0:

- hygiene, identity, architecture, tokens, typecheck
- tests + coverage floors (`c8.config.json`)
- proof harness + pack check
- dod emitter itself green

On `quality:full` / main mutation job: Stryker ≥ break 80 on the three pure modules.

Never mark done on coverage alone. Never weaken tests to pass mutation.

## Oversized files (token baseline)

`config/token-baseline.json` allow-list (chars/4). New files and non-baselined growth still hard-fail at 2500.

Current allow: `store/database.ts`, `index.ts`, `controller.ts` (M0), `runtime.ts`, and a few adapters (`grok-cli`, `openclaw-acp`, `mocks` ≤2320, `acp-worker`). `core/settlement.ts` is **not** waived — stay under the error ceiling via split files (`plan-text.ts`, `plan-settle.ts`, `land-closeout.ts`). Store row mapping lives in `store/mappers.ts`.

Mutation surface stays on budget / lease / safety until a later ticket.

## DIGEST-032 / PLAN.md matrix

See `test/quality-matrix.test.ts` plus the phase1–6 suites. Remaining product gaps (not quality-tooling): ACP cancel on emergency-stop, live usage DTO.
