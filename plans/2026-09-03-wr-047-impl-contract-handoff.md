# WR-047 — Freeze AWC conditions as IMPL_CONTRACT.md (PLAN)

**Tickets:** WR-047 (this repo) then CA-016 (crawmak forge). Two IMPLs — do not edit crawmak from the WR worktree. Forge slice: crawmak `tmp/workers/CA-016/PLAN.md`.
**Verify (WR):** `npm test && npm run quality`
**Verify (CA-016):** ticket `verify:` grep + `bash scripts/kick_selftest.sh`
**Land:** WR `commit` + push origin. Forge: files only, no product from WR.
**COSP / UX:** none.

Handoff for a **fresh IMPL**.

APPROVED by Jason

## Goal / AC

Make `approve-with-conditions` mean “IMPL must honor Crawmak deltas” without a second PLAN hop, without mutating `PLAN.md`, and without a live-Grok harness test.

Quote runbook (today, `docs/OPERATOR-RUNBOOK.md` Agent plan-gate): Crawmak Verdict `approve` / `approve-with-conditions` **is** ledger-approve; review cwd is forge; IMPL is a fresh worker on `planArtifact`. That stays. **Patch (live):** AWC also requires a frozen `IMPL_CONTRACT.md` on the IMPL attempt; empty AWC does not admit.

## Live vs contract-only

| Live this land | Contract-only / later |
|---|---|
| Extract + admit fail-closed + freeze copy + IMPL brief pointer + tests + probe + runbook | PLAN `## Read first` as `checkPlanArtifact` regex |
| CA-016 templates/kick (forge IMPL) | Mona UX fold, impl-review default, SuperGrok meter, ACP usage DTO |

## Spec paths (WR — patch same pass as code)

- **`docs/OPERATOR-RUNBOOK.md`** § Agent plan-gate (WR-023/028/033/037) — **live**. Insert after the Crawmak-verdict bullets:

  - Review **does not edit** `planArtifact`. Hop-global PLAN mutation is out (WR-038 class).
  - After Crawmak `approve-with-conditions`, admit is **blocked** until `## Conditions or revise` has a non-empty body that is not a none-token (`none` / `n/a` / `—`). Ticket stays `PLAN_REVIEW`, `result=missing_impl_contract`. REVIEW hop is **not** re-queued (`hasHopLaunch` still true). Operator/Crawmak edits `crawmak/reviews/<ID>.md`; next tick admits. Over **8000** chars → `impl_contract_too_large` (no silent clip).
  - `approve`, `plan_review: skip`, leftover stamp **with no Crawmak launch**: no contract file.
  - IMPL launch copies extract bytes to `<attempt>/IMPL_CONTRACT.md` (peer of `APPROVED_PLAN.md`). Spawn task **names the file**. Do not inline Findings / Cheat-mode / Learn / Research request.
  - IMPL executes PLAN + contract. Do not re-derive inventory. Named-file contradiction → revise, not a hunt.
- **`docs/QUALITY-GATES.md`** — **live** one line: WR-047 handoff is `test/wr-047-impl-handoff.test.ts` + `npm run probe:handoff` (no xAI). Quality green = current HEAD `npm run quality` (WR-018).
- **`README.md`**: no hop-count change; optional one-liner under plan→approve→fresh impl is fine if it stays accurate. Do not rewrite the 51M-drain story.

## Spec paths (CA-016 — forge, separate IMPL)

- `templates/PLAN_BRIEF.md`, `templates/IMPL_BRIEF.md`
- `playbooks/plan-review.md` (drop “copy into IMPL brief” as a human wish; WR/kick freeze it)
- `skills/review-quality/SKILL.md`, `skills/plan-impl/SKILL.md`, `reviews/README.md`
- `scripts/kick.sh` + `scripts/kick_selftest.sh`
- **Not** `LESSONS.md` / `AGENTS.md` / `SOUL.md` / `profile.md` from Learn
- Jason reads `reviews/CA-016.md` (forge-gate)

## Read first (IMPL)

| Path | Change |
|---|---|
| `src/core/impl-contract.ts` | **new.** `extractImplContract`, `implContractRequired`, none-tokens, cap 8000. No adapter imports. |
| `src/core/plan-review.ts` | Keep `checkPlanReview` / `VERDICT_RE`. Do not duplicate extract here; call `impl-contract.ts` from admit. |
| `src/core/plan-review-settle.ts` | After approve-class verdict, if `implContractRequired` and extract not ok → **do not** `putTicketStatus(..., "APPROVED")`. Set `result` to `missing_impl_contract` / `impl_contract_too_large`. Stay `PLAN_REVIEW`. Do not insert `plan_review_revise`. Do not queue PLAN. |
| `src/core/launch.ts` `intentFromOutbox` | IMPL: resolve forge (`forgeForWave` / `resolveCrawmakForge`), extract, `writeImplContract(outputDir)`. Skip-bit / no-review leftover: skip write. |
| `src/adapters/stage-briefs.ts` | IMPL block: honor `IMPL_CONTRACT.md` if present; do not re-inventory; do not paste review essay into `task`. |
| `src/adapters/acp-worker.ts` | Copy/ensure `IMPL_CONTRACT.md` like `APPROVED_PLAN.md`. |
| `src/adapters/grok-cli.ts` | Same copy; default IMPL brief names the file. |
| `src/core/ports.ts` `LaunchIntent` | Optional `implContractPath?: string` only if a test needs it; prefer writing the file in `outputDir` so adapters stay dumb. |
| `test/wr-047-impl-handoff.test.ts` | **new.** Table + simulator. |
| `test/fixtures/handoff/` | Tiny review/plan fixtures for golden brief + probe. |
| `scripts/probe-impl-handoff.ts` | `--review` `--plan` optional. Print verdict, chars, `would_admit`, reason, brief head. Exit 1 on fail-closed. Zero network. |
| `package.json` | `"probe:handoff": "npm run build && node dist/scripts/probe-impl-handoff.js"` — **not** a `quality` extra if `npm test` already execs the probe once. Prefer: unit-test the probe with `spawnSync` on fixtures (WR-046 supervisor style). |
| `docs/OPERATOR-RUNBOOK.md` `docs/QUALITY-GATES.md` | Spec patches above. |

## Do not open

`src/core/settlement.ts` (token ceiling). `src/core/state-machine.ts` (no new statuses). Hop counts / `launch-hops.ts`. WR-038 `planReviewHopReady`. `checkPlanArtifact` headings. `SAFETY.supervisedMaxTokens` / ACP slots as a SuperGrok cap. `crawmak/` from this worktree.

## Approach (one path)

1. **Pure extract** — regex `^##\s+Conditions or revise\b` through next `^##\s+` or EOF. Trim. None-tokens: `/^(none|n\/?a|—|-)\s*$/i` on the whole body. Cap: `body.length > 8000` → `{ ok:false, reason:"impl_contract_too_large" }`. Verdict parsed by existing `checkPlanReview` (do not re-implement verdict).
2. **Admit** — in the existing `review.ok && (approve|approve-with-conditions)` branch, **before** `APPROVED`: if verdict is AWC, `extractImplContract(readFileSync(reviewFile))`. Fail → stay PLAN_REVIEW. `approve` skips extract. `revise` path unchanged.
3. **Launch freeze** — `copyFile` pattern: write `outputDir/IMPL_CONTRACT.md` only when extract ok. If IMPL is launching and AWC required but file missing (race) → do not `acp.spawn`; mark launch failed `missing_impl_contract` (belt). Do not read forge file again after freeze.
4. **Brief** — two sentences in `stageBrief` IMPL, not the 70-line review.
5. **Tests first, then the pipe** (same ticket, tests land with the code — not a live wave).

### Test matrix (must exist or the land is incomplete)

| Case | Assert |
|---|---|
| AWC + real conditions | admit APPROVED; IMPL intent; `IMPL_CONTRACT.md` contains the bite; spawn `task` includes `IMPL_CONTRACT.md` and **does not** include `Cheat-mode scan` |
| AWC + missing heading / empty / `none` | still PLAN_REVIEW; `result=missing_impl_contract`; **zero** IMPL intents; no second REVIEW launch |
| AWC + 20k body | `impl_contract_too_large`; no clip; no IMPL |
| `approve` + no section | IMPL launches; no contract file (or skip) |
| `plan_review: skip` | `plan_gate_auto` → IMPL; no contract |
| leftover stamp, no Crawmak launch | IMPL; no contract (WR-033 leftover) |
| `planArtifact` sha256 | unchanged across REVIEW admit |
| REVIEW cwd forge / IMPL cwd worktree | keep WR-028 asserts |
| hop not ready (WR-038) | do not admit on stale revise; do not treat that file as contract |
| `stageBrief` golden | fixture 12-line review |
| `probe:handoff` | exit 0 AWC+body; exit 1 AWC+empty; no network |

Mocks/simulator only (`createSimulator`, `writeReview`). **No** `grok` binary. **No** `sessions_spawn`.

## Ordered IMPL steps (WR-047)

1. Add `impl-contract.ts` + table tests (red/green without settle).
2. Wire admit fail-closed; simulator AWC-empty (no IMPL).
3. Write freeze + stage-brief + acp/grok-cli copy; simulator AWC-happy.
4. Probe script + spawnSync test.
5. Patch OPERATOR-RUNBOOK + QUALITY-GATES.
6. `npm test && npm run quality` on **this HEAD**. Commit JCraw noreply; push (`push_on_land`).

## Ordered IMPL steps (CA-016, after or immediately before WR-047 fail-closed)

1. PLAN/IMPL templates + review skill/README/playbook.
2. `kick.sh` writes `IMPL_CONTRACT.md`; AWC empty exits 2; selftest.
3. Jason reads `reviews/CA-016.md`.

## Out

Grok worker caps. Review rewriting PLAN. Extra hop / LEARNED session. Dumping whole review into ACP `task` (RRT-033 oversized-brief). `checkPlanArtifact` `## Read first` this land. Live Grok as merge gate. Changing `supervisedAcpSlots`. Mona `IMPL_CONTRACT`. Overnight/drain.

## Verify

```bash
npm test && npm run quality
```

Exit 0 on WR HEAD. Probe is covered by tests; operator may also run `npm run probe:handoff -- --review test/fixtures/handoff/awc.md`. Captures/Pixel/Discord: none.

## Learn

- bite: harness
- candidate: AWC verdict without a frozen conditions file → IMPL re-scouts or misses bites → fail-closed admit + IMPL_CONTRACT.md copy (do not mutate PLAN)
- promote: no
