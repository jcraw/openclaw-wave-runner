# WR-008 plan — Split agent plan-gate from human WAITING_APPROVAL

**Ticket:** `issues/WR-008-approval-hop-to-done.md`
**Impl:** later fresh session. This file is the contract. Not authorization to ship.
**Verify (impl):** `npm test` + `test/operator-contract.test.ts`

## 1. Goal / acceptance

Jason 2026-08-14: `WAITING_APPROVAL` = **human hold**. Astra reading a plan is the **next hop** (Grok plan → Astra common-sense approve → impl).

| # | Acceptance | How |
|---|---|---|
| A1 | Default plan-ready is agent-gate, not human-hold | PLAN settle + `policy.decide()==="wait"` + no human flags → wave `AWAITING_PLAN_GATE` |
| A2 | Kicked wave PLAN → Astra → IMPL without Jason (MUD-036) | durable one-shot wake; operator loop does **not** `exit 0` |
| A3 | Next ticket in same wave gets the same hop (MUD-038) | every agent PLAN settle re-enters gate + new wake keyed by ticket+revision |
| A4 | `needs_jason` / `human_gated` still `WAITING_APPROVAL` and stop | human flags → current stop; **no** wake |
| A5 | Tests fail if agent-gate has no wake receipt | ledger event required; `approve()` is not a substitute |

Astra still **reads** the plan. Do **not** bash-stamp `APPROVED`.

## 2. Current inventory

**Wave vs ticket (today):**
- Ticket already has `PLAN_REVIEW` (owner `operator`, next `approve-or-revise`).
- PLAN success + `SafePolicy.decide()==="wait"` **promotes the wave** to `WAITING_APPROVAL` (`src/core/settlement.ts` ~96–98). `safe-policy` / `docs-only` / `deterministic-fixture` auto-approve (no wait).
- `tickWave` / `advanceReadyTickets` / `runUntilIdle` treat `WAITING_APPROVAL` as idle/stop (`src/core/tick.ts` 113, 176, 198).
- `approveWave` returns wave `WAITING_APPROVAL` → `RUNNING` (`wave-commands.ts` 178–185). `reviseWave` does **not** move the wave (gap).
- M0 `src/controller.ts` / `test/controller.test.ts` `approve(flowId, revision)` is TaskFlow — **out of scope**.

**Human flags:**
- `eligibleForBoundedWave` rejects `needs_jason` / `eligibility: human_gated|feature_done_gate` for **auto-admit**.
- Explicit `--tickets` **ignores** eligibility (`test/ticket-interop.test.ts`) — those tickets **can** enter a wave. Flags are **not** persisted on `FrozenTicket` / `TicketRun`. Settle cannot tell agent-gate from human-hold.

**Operator exit / missing wake:**
- `scripts/wave-operator.sh` **does not exist** in this public package. Ticket assumes a `loop` that exits on `WAITING_APPROVAL`.
- No `systemEvent` / cron `at` / wake port. `WorkflowBackend.waitForApproval` is TaskFlow projection only (non-authoritative; `WAITING_APPROVAL` + `flowId`).
- Event exists (ticket `PLAN_REVIEW`); **listener does not**. MUD-036/038 sat until a human asked.

**Tests calling `approve()`:** `phase2-slice` and phase1/3 drive `controller.approve(waveId, ticketId, revision)` after asserting wave `WAITING_APPROVAL`. That is a **fixture stamp**, not an Astra wake.

## 3. Recommended approach (one)

**New wave status `AWAITING_PLAN_GATE` + durable wake receipt.** Keep ticket `PLAN_REVIEW`. Do **not** overload `RUNNING` (would let `advanceReadyTickets` claim the next ticket; `runUntilIdle` would spin).

Fork at PLAN settle after `policy.decide()`:

```
auto-approve          → ticket APPROVED (unchanged)
wait + humanHold      → wave WAITING_APPROVAL; no wake; operator STOP
wait + default        → wave AWAITING_PLAN_GATE; emit wake once; tick idles; operator does not exit
```

`humanHold` from persisted snapshot flags (`needs_jason` truthy, or `eligibility` in `human_gated` / `feature_done_gate`). Missing field = **agent-gate** (A1).

Wake is a **ledger fact** (`DomainEvent` type `plan_gate_wake`, payload `{waveId,ticketId,planPath,revision}`), idempotent on `(waveId, ticketId, revision)`. Optional `WakePort.emitOnce` for host (`systemEvent` / `at now`); absent port still records the event. Tests assert the **event**, not a live cron.

After `approve` / `revise`: `AWAITING_PLAN_GATE` → `RUNNING` (also fix `revise` for `WAITING_APPROVAL`). Next agent PLAN in the same wave repeats the hop (A3).

## 4. Types / transitions / owners

**`WaveStatus` +** `"AWAITING_PLAN_GATE"` (non-terminal). SQLite status is a string — no schema migration.

```
RUNNING            += AWAITING_PLAN_GATE
AWAITING_PLAN_GATE → RUNNING | PAUSED | CANCELLED | BLOCKED | FAILED | BUDGET_STOPPED
WAITING_APPROVAL   unchanged
```

| | owner | next |
|---|---|---|
| wave `AWAITING_PLAN_GATE` | `plan-gate` | `wake-or-approve-or-revise` |
| wave `WAITING_APPROVAL` | `operator` | `approve-or-revise` (keep) |
| ticket `PLAN_REVIEW` + agent-gate | `plan-gate` | `approve-or-revise` |
| ticket `PLAN_REVIEW` + human-hold | `operator` | `approve-or-revise` |

**Persist (optional fields, manifest schema 1 compatible):**
- `FrozenTicket.humanHold?: boolean`
- `FrozenTicket.humanHoldReason?: "needs_jason" | "human_gated"`
- same on `TicketRun`; copy in `ticketFromFrozen`

**Trackers:** parse frontmatter / JSON at snapshot. JSON: `needs_jason` or `eligibility`.

**Settle:** write wake event in the same transaction as the wave status change. Do **not** call `waitForApproval` for agent-gate.

**tick / projection:** treat `AWAITING_PLAN_GATE` like `WAITING_APPROVAL` for idle/advance/`canPause`. Operator (not tick) distinguishes stop vs stay.

**Ports:** add `WakePort` (`emitOnce` → void). Mock records calls. Wire no-op or host bind in runtime; **do not** rewrite ACP spawn.

**PolicyAdapter** unchanged (`auto-approve` \| `wait`). Human vs Astra is **not** a third policy class.

## 5. Operator script contract

Add `scripts/wave-operator.sh` in **this** public repo (`loop` subcommand).

| Wave status | Loop |
|---|---|
| `RUNNING` | `tick` |
| `AWAITING_PLAN_GATE` | ensure wake receipt exists (idempotent); **do not** `exit 0`; inspect-wait (sqlite/`inspect`, **not** LLM) until status leaves the gate, then continue |
| `WAITING_APPROVAL` | print `OPERATOR_STOP waiting_human`; `exit 0` |
| terminal / `PAUSED` | existing stop / inspect |

No `approve` from bash. No recurring LLM poll. No overnight/drain.

Workspace `projects/agent-backlog-wave-runner/` is a **separate copy** — impl may **mirror this script only** if that tree exists; do not fork settlement there.

## 6. Tests

New `test/operator-contract.test.ts` (controller + inspect; script contract via a small exported helper `operatorLoopDecision(status)` so we do not need a live bash daemon):

1. **Agent-gate without wake = fail.** Default / `agent_eligible` PLAN → wave `AWAITING_PLAN_GATE`, ticket `PLAN_REVIEW`, events contain `plan_gate_wake` with plan path + revision. Drop the emit → test fails.
2. **Human-hold without wake = pass.** Explicit ticket with `needs_jason` or `eligibility: human_gated` → `WAITING_APPROVAL`, **zero** `plan_gate_wake`. Loop decision = `OPERATOR_STOP`.
3. **`approve()` is not a wake.** After fixture `approve()`, event type is `approve` only; count of `plan_gate_wake` unchanged. Driving IMPL via `approve()` does not satisfy test 1.
4. **Second ticket (MUD-038).** After first agent hop DONE, next agent PLAN → new `AWAITING_PLAN_GATE` + new wake (different ticket/revision).
5. **safe-policy** still auto-approves (no gate, no wake).

Flip existing `WAITING_APPROVAL` assertions after **default** PLAN to `AWAITING_PLAN_GATE`: `test/phase1-core.test.ts`, `phase1-fault.test.ts`, `phase1-property.test.ts`, `phase2-slice.test.ts`, `phase3-pilot.test.ts`. Leave M0 `test/controller.test.ts` alone.

## 7. Ordered impl steps

1. Types + `humanHold*` on frozen/ticket + tracker parse + `ticketFromFrozen`.
2. State machine: status, transitions, owners, next.
3. Settle fork + wake event (+ `WakePort` no-op/mock). `approve`/`revise` resume `AWAITING_PLAN_GATE` → `RUNNING`.
4. tick / `runUntilIdle` / projection `canPause` include new status as idle (not terminal).
5. `operatorLoopDecision` + `scripts/wave-operator.sh`.
6. Tests (new contract + flip old default-PLAN expects).
7. Runbook one paragraph: agent-gate vs human-hold. Ticket acceptance boxes at impl time.

## 8. Out of scope

Overnight, drain, merge/push/deploy, ACP spawn rewrite, auto-approve without reading the plan, recurring LLM poll, rewriting M0 TaskFlow `src/controller.ts` unless a type compile forces a union update (prefer not), new ticket statuses, retroactive wake of in-flight human holds.

## 9. Risks

- **In-flight waves** already `WAITING_APPROVAL`: leave as human-hold; **no** retroactive wake. Next PLAN settle uses the new fork. Operator loop on an old wave still stops (correct fail-closed).
- **Plugin vs public repo:** implement in this public package. Do not edit the workspace copy except optional script mirror. Two trees diverging on settle would re-break MUD-036.
- **Manifest hash:** new optional frozen fields change hashes only for tickets that set them (human-hold). Default agent tickets stay hash-stable if fields omitted.
- **`revise` wave stuck:** fix both gates or REVISING never launches.
- **Wake host missing:** ledger event still required; host emit is best-effort. Tests must not depend on cron.
- **Admission vs settle:** explicit `--tickets` is the human-hold fixture path; do not silently start auto-admitting `needs_jason`.

---

## Self-review (architecture)

**Acceptance covered:** A1 default agent-gate; A2 one-shot wake + loop stay; A3 per-ticket hop; A4 human flags → `WAITING_APPROVAL` + stop + no wake; A5 wake receipt mandatory; Astra reads plan (no bash `APPROVED`).

**Out of scope held:** no overnight/drain/merge/ACP/M0 rewrite/LLM poll.

**Verify (impl session):** `npm test` (includes `test/operator-contract.test.ts`).

**Blast radius:** `types.ts`, `state-machine.ts`, `settlement.ts`, `tick.ts`, `wave-commands.ts`, trackers, `wave-create.ts`, projection, new `WakePort`, new operator script + contract test, flip of default-PLAN expects in phase1–3. Not M0 TaskFlow. Not ACP. SQLite: new status string only.

**Why not “keep wave RUNNING”:** `advanceReadyTickets` would skip `PLAN_REVIEW` and claim the next ticket; operator could not distinguish a live tick from a plan-gate. Explicit wave status is the contract.

**Why not reuse `waitForApproval`:** that path is TaskFlow operator-wait, already non-authoritative, and is what collapsed the hop into a human park.

Ready for **Astra common-sense review**. Impl = fresh session against this file.
