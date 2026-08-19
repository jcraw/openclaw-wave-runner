# WR-023 plan — deterministic agent plan-gate

**Ticket:** `issues/WR-023-deterministic-plan-gate.md`  
**Verify:** `npm test && npm run quality`  
**Closeout:** `land: commit` + push origin  
**Author:** `JCraw <4335668+jcraw@users.noreply.github.com>`

PLAN is the contract. Jason directed impl in the same session (2026-08-19).

**APPROVED by Jason 2026-08-19** (direct). Not an Astra stamp.

## 1. Goal

Kick a supervised drain. Agent-eligible tickets run PLAN → IMPL → verify → closeout with **zero LLM orchestration tokens** after PLAN. Jason is only in the loop when the ticket YAML says so.

Workers stay LLMs. The hop after PLAN is a script.

## 2. Findings

| # | Fact | Gap |
|---|---|---|
| F1 | WR-008 `AWAITING_PLAN_GATE` + `plan_gate_wake` ledger event | `WakePort` never passed from CLI. Event exists; nobody listens. |
| F2 | `run-backlog-wave.sh` `AUTO_PLAN_GATE=1` appends `APPROVED by Astra (auto plan-gate)` | Invented Astra. WR IMPL does not even grep that string. |
| F3 | Crawmak review + `openclaw cron wake --text` | Review is not a WR stage. Wake flag does not exist. Drain stops after PLAN. |
| F4 | `resolveHumanHold`: any non-empty `needs_jason` string is a hold | `needs_jason: pick` parks GR-183 before gen. |
| F5 | `eligibleForBoundedWave` treats any truthy `needs_jason` as ineligible | Same class as F4. Drain selector does not skip real holds today. |
| F6 | SafePolicy `wait` is the default for `planClass: manual` | Every real ticket hits the dead Astra hop. |

Out of this ticket: WR-022 apply-closeout (jam dirty primary). Without it, jam waves can still `CLOSEOUT_DEBT` after green IMPL. Do not mix.

## 3. Decisions

| # | Pick |
|---|---|
| D1 | After a passing plan artifact check, `!humanHold` tickets go `APPROVED` in `applyPlanSuccess`. Wave stays `RUNNING`. IMPL admits on the next tick. No `AWAITING_PLAN_GATE`. |
| D2 | Artifact check is pure (`src/core/plan-artifact.ts`): non-tiny text, ticket id present, no `BLOCKED` / `NEEDS_JASON` heading, ticket `verifyCommand` appears unless it is the fixture `"true"`. Fail → ticket `FAILED` `plan_artifact: …`. Lane continues. |
| D3 | Keep `AWAITING_PLAN_GATE` in the state machine and operator (human-debug / leftover). Default agent path never enters it. Do not emit `plan_gate_wake` for auto-approve. Emit `plan_gate_auto` `{ticketId,revision,reason}` as the receipt. |
| D4 | `needs_jason` hold only: boolean `true`, or string `true` / `yes` / `1` / `hold` / `required`. Empty / `false` / `0` / `no` / `pick` / `opinion` / other annotations → not a hold. `eligibility: human_gated` / `feature_done_gate` still hold. |
| D5 | Drain select skips `humanHold` tickets (`needs_jason <id>`). `eligibleForBoundedWave` uses the same predicate. |
| D6 | `AUTO_PLAN_GATE=1` may still `wave-operator.sh approve` if a wave is in `AWAITING_PLAN_GATE`. **Never** append `APPROVED by Astra`. No markdown stamp. |
| D7 | Do not wire `WakePort`. Do not add Crawmak review to WR. Do not invent Astra. |
| D8 | Crawmak `kick.sh` also accepts `APPROVED by operator` so a mixed single-ticket impl does not die if someone later stamps operator. Astra/Jason remain valid. |

## 4. Approach

### P0.1 — `needsJasonIsHold` + `checkPlanArtifact`

Pure modules. Tests in `test/wr-023-plan-gate.test.ts` (no sim required for these).

### P0.2 — `applyPlanSuccess`

Order: PLAN_REVIEW → artifact fail/FAILED → policy auto-approve → humanHold/WAITING_APPROVAL → else APPROVED + `plan_gate_auto`. Do not set `AWAITING_PLAN_GATE`.

### P0.3 — selector + studio eligibility

`selectEligibleTickets` and `eligibleForBoundedWave` share `needsJasonIsHold`.

### P0.4 — operator scripts + runbook

Strip Astra bash-stamp. Runbook: agent PLAN auto-continues; Jason hold is YAML-only.

### P0.5 — flip WR-008 wait assertions

Default FX-001 PLAN no longer parks. `runUntilIdle` proceeds to IMPL/DONE. Tests that `approve()` after PLAN keep `approve` as a no-op-safe leftover **or** drop it. INDETERMINATE/budget tests: PLAN auto-approve then IMPL admit throws `Admission denied` inside `runUntilIdle` / next `tick`.

## 5. Tests

| Contract | Assert |
|---|---|
| agent PLAN | wave not `AWAITING_PLAN_GATE`; ticket `APPROVED` or further; `plan_gate_auto` present; zero `plan_gate_wake` |
| agent PLAN → DONE | `runUntilIdle` completes FX-001 without `approve()` |
| human hold | `needs_jason: true` → `WAITING_APPROVAL`, no auto, no wake |
| `needs_jason: pick` | not a hold; parse + eligible |
| tiny / BLOCKED plan | `FAILED` `plan_artifact:` |
| verify string | non-`true` verify must appear in plan text |
| select skip | `needs_jason: true` skipped; `pick` eligible if agent + verify |
| AUTO_PLAN_GATE | script no longer writes `APPROVED by Astra` (grep the script) |

## 6. Must not

- WR-022 apply logic
- SAFETY flips
- Recurring LLM poll
- Self-stamp Astra
- Grow `settlement.ts` (keep check in `plan-artifact.ts` / `plan-settle.ts`)
