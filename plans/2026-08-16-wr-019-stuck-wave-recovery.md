# WR-019 plan — P0/P1 stuck-wave recovery

**Ticket:** `issues/WR-019-p0-p1-stuck-wave-recovery.md` (missing in this worktree — IMPL adds it)
**Product plan (Astra stamp target):** `plans/2026-08-16-wr-019-stuck-wave-recovery.md`
**Incident:** `BL-RR-070-068-20260816104319` (RR-070 + RR-068, writer scope `game:rink_rush`)
**Stamp:** `APPROVED by Astra` on the product plan before IMPL. Do not self-stamp.
**Verify (impl):** `npm test`
**Land gate:** `npm test && npm run quality`
**Author:** `JCraw <4335668+jcraw@users.noreply.github.com>` + push `origin` (public package standing)

This file is PLAN ONLY. No product code in this turn.

## 1. Goal

Same-scope multi-ticket waves **fail closed and recover**. An IMPL that is no longer active never keeps a writer lease. A wave leaves `RUNNING` when nothing can run. The operator loop cannot burn ticks on a frozen fingerprint. Admit never discovers `missing_verify` after a paid IMPL launch.

Do **not** reopen WR-018: settle still fail-closes on missing verify. This ticket is **recovery** + **admit-time** enforcement + operator/runbook hygiene.

## 2. Incident (why this ticket exists)

Supervised wave `BL-RR-070-068-20260816104319` wedged:

1. Tickets frozen **without** `verifyCommand` → IMPL settle correctly failed `missing_verify` (WR-018).
2. Worker still produced real IMPL work; ticket = **FAILED**.
3. Writer lease for `game:rink_rush` **stayed held by RR-070** after that fail.
4. RR-068 sat `APPROVED` / `nextAction: launch-impl` forever (`advanceReadyTickets` skips when `lease.ticketId !== ticket`).
5. Wave stayed **RUNNING**; operator looped 100+ no-op ticks.
6. Late-editing ticket frontmatter after freeze did nothing (manifest already frozen).

## 3. Facts (this tree, today)

- `settlement.ts` releases the writer lease **only** on IMPL success (`lease.ticketId === ticket`), then lands. Fail / cancel / `missing_verify` / `stale_fence` / verify-fail **do not** release.
- `launch.refreshHeldLeases` renews every lease this process holds. A FAILED ticket’s lease **never TTL-expires** while the operator still ticks.
- `maybeCompleteWave` fires only when every ticket is `TERMINAL_TICKET`. `APPROVED` is not terminal → wave stays `RUNNING`.
- Existing terminal mapping (keep): all DONE → `COMPLETED`; any FAILED/BLOCKED/BUDGET_STOPPED → `FAILED`; all CANCELLED → `CANCELLED`.
- `cancelWave` / `stopForBudget` / `emergencyStop` do not release leases.
- Land runs **after** the success-path release. Land fail does not re-hold. No double-free on land.
- `dryRun` / `createWave` copy `verifyCommand` if present; no admit gate. WR-018 only fails at IMPL settle (after reservation + launch).
- Tick order already helps recovery: `observeLaunched` (settle) **then** `advanceReadyTickets`. Same-tick sibling IMPL is possible **if** the fail path releases first.
- Operator: `wave-operator.sh` loop + duplicated `run-backlog-wave.sh` loop. Terminal exits already (0 `COMPLETED`, 1 `FAILED|CANCELLED|BUDGET_STOPPED|BLOCKED`). No stuck fingerprint. Plan-gate wait is not an exit.
- `inspect` already returns `tickets[].result`, `leases`, `artifacts`. Result can be thin if the worker summary is empty and the controller flip is not named.
- `MockWorkspace.verify`: `ok = command !== "false"` — use `"false"` for a verify-fail fixture.
- Token ceilings: do not baseline `settlement.ts` / `tick.ts`. Extract rather than grow them.

## 4. Decisions

| # | Pick |
|---|---|
| D1 | New `src/core/lease-release.ts`: `releaseWriterLeaseIfHeld(ctrl, wave, ticket)` + `releaseInactiveWriterLeases(ctrl, waveId)`. Idempotent. Catch `releaseLease` fencing errors; do not throw out of settle/cancel. Keeps `settlement.ts` under 2500 tokens. |
| D2 | **Release on IMPL inactivity, not on retry re-arm.** Release when the ticket is `FAILED` / `CANCELLED` / `BUDGET_STOPPED` / `BLOCKED` / `DONE`, or on the existing success path at `VERIFYING`. **Do not** drop the lease when WR-010 re-arms IMPL to `APPROVED` — same-scope serial (WR-011) stays: sibling waits; the retrier keeps the key and re-queues. Ticket P0.1 lists FAILED/CANCELLED/verify-fail/`missing_verify`/`stale_fence`/land-if-still-held, not retry. |
| D3 | Call the helper from: settlement fail branch (after `putTicketStatus`), `cancelWave`, `stopForBudget`. Success path keeps today’s release-before-land. Belt: `refreshHeldLeases` renews only if the holder ticket is `IMPLEMENTING`, `VERIFYING`, or `APPROVED` (pending IMPL retry). `advanceReadyTickets`: a lease whose `ticketId` is terminal is treated as free (delete, then queue). |
| D4 | Keep `maybeCompleteWave` all-terminal mapping. After `advanceReadyTickets`, if wave is still `RUNNING`, no open outbox, no ticket in `{PENDING,CLAIMED,PLANNING,IMPLEMENTING,VERIFYING,REVISING,PLAN_REVIEW}`, leftover `APPROVED` that is blocked only by a **terminal-held** lease → mark `FAILED` / `unlaunchable: no progress`, then `maybeCompleteWave`. **Do not** fail `APPROVED` this tick solely because a **live foreign** lease exists (other wave/process) — leave `RUNNING`; P0.3 is the backstop. **Do not** fail `PLAN_REVIEW`. **Do not** complete `AWAITING_PLAN_GATE` / `WAITING_APPROVAL` / `PAUSED`. |
| D5 | Stuck stop: env `STUCK_TICKS`, **default 20**. Fingerprint = `wave.status` + per-ticket `id,status,revision,result` + outbox `id,state` + lease `key,holder,ticketId`. Increment only while `RUNNING`. Print `OPERATOR_STOP stuck`, exit 1. Reset on any fingerprint change or non-RUNNING. `AWAITING_PLAN_GATE` is not stuck. |
| D6 | Empty/missing `verifyCommand` → fail closed at **dry-run and create** (before persist). Explicit `"true"` allowed (fixture). YAML `verify: true` already becomes `"true"` in the markdown adapter. Error lists ticket ids. Code `missing_verify` (`WaveError` or `AdmissionDeniedError`). |
| D7 | One landable commit preferred. Two OK if split: (1) core P0.1+P0.2+P0.4+P1.3 (2) operator/docs P0.3+P1.1+P1.2. |

## 5. Approach

### P0.1 — release writer lease on IMPL inactivity

- Helper walks leases for the wave. If the holder ticket is missing or not IMPL-active (`IMPLEMENTING` / `VERIFYING` / `APPROVED`) and we are the claimant → `releaseLease` + `deleteLease`.
- Settlement **fail** branch: after ticket mutate, call helper. Covers worker fail, verify fail, `missing_verify`, `stale_fence`, operator cancel during settle.
- Settlement **success** branch: keep the existing release at `VERIFYING` (sibling may start during land — current behavior).
- `finalizeImplLand` fail: lease already gone; no re-hold. Helper is a no-op if invoked.
- `cancelWave` + `stopForBudget` (and therefore `emergencyStop`): sweep after tickets are terminalized.
- Do **not** change `releaseLease` identity / generation / PID-reuse rules.

### P0.2 — wave leaves RUNNING

- `maybeCompleteWave` unchanged for the all-terminal case.
- Small `failUnlaunchableApproved` in `tick.ts` (or a 20-line extract if `tick.ts` would cross 2500 tokens) immediately **before** `maybeCompleteWave` and **after** `advanceReadyTickets`.
- Prove: A IMPL fails → B same scope launches **this or next tick** with **no** clock TTL wait; wave becomes `FAILED` or `COMPLETED` per existing mapping.

### P0.3 — operator stuck stop

- Pure helpers in `operator-loop.ts`: `progressFingerprint(view)` + `nextStuckCount(prev, next, n, threshold)`. Unit-test those. No LLM.
- Bash: `wave-operator.sh` **and** `run-backlog-wave.sh` hash inspect/tick JSON with the same field set. Env `STUCK_TICKS` (default 20).
- `run-backlog-wave.sh` currently `tick || true` — still fingerprint the inspect/tick JSON so a silent tick fail cannot spin forever.
- Do not count `AWAITING_PLAN_GATE` / `WAITING_APPROVAL` / `PAUSED`.

### P0.4 — admit requires verifyCommand

- `assertTicketsHaveVerify(tickets)` after snapshot in `dryRun` + `createWave` (before persist).
- WR-018 test `missing verifyCommand fails IMPL…` **will break** (create rejects). Rewrite: create with `"true"`, strip `ticket.verifyCommand` on the row, run IMPL → still `missing_verify`. That keeps the settle belt for old/mutated ledgers.
- Do not default missing verify to `"true"`.

### P1.1 — runbook + kick hygiene

- Canonical: `docs/OPERATOR-RUNBOOK.md` + a short README pointer.
- Kick checklist: `verify` / `verify_command` in frontmatter · `agent_eligible` · no stale writer lease on the scope · caps set.
- Until a live 2-ticket same-scope smoke is green: **one ticket per wave** when tickets share `writerScope` / same game. Same-game multi-ticket = serial **waves**, not one multi-ticket wave.
- Do not late-edit tickets after freeze; cancel + recreate.
- Cite incident wave id `BL-RR-070-068-20260816104319`.
- IMPL also adds `issues/WR-019-p0-p1-stuck-wave-recovery.md` (ticket body) so the board matches the contract.

### P1.2 — preflight

- Enrich `dryRun` JSON: `admitBlockers: [{ticketId, code, message}]`. Fail create/dry-run if any `missing_verify`. Warnings (do not fail create): `human_hold`, `shared_writer_scope` (ids sharing a scope).
- Document dry-run as the preflight. No new CLI verb unless a 10-line `preflight` alias is cheaper than docs.

### P1.3 — inspect honesty

- If the worker receipt was `succeeded` and the controller flips to failed: `ticket.result` = `controller failed (worker succeeded): <reason>` (`missing_verify` / verify proof / `stale_fence`). Cap 500 chars (existing `clipReason`).
- Persist artifact `kind: "settle-reason"` with that string. `inspect` already surfaces `result` + `artifacts`.
- Worker-failed receipts keep today’s `stageDeathReason` (no false “worker succeeded” prefix).

## 6. Tests (`test/wr-019-stuck-recovery.test.ts` + extend existing)

| Contract | Assert |
|---|---|
| lease-on-fail | same `writerScope`; A `verifyCommand: "false"`, `maxRetriesPerStage: 0` → A FAILED, **no** lease row for A; B launches IMPL / reaches DONE with clock **unmoved** |
| retry keeps lease | A empty IMPL death with `maxRetriesPerStage: 1` → A `APPROVED`, lease still A; B same scope does **not** take IMPL until A terminals |
| cancel releases | IMPLEMENTING then `cancel` → lease row gone |
| emergency-stop releases | live IMPL lease → `emergencyStop` → lease gone |
| wave FAILED | A fail + B fail (or unlaunchable) → wave `FAILED`, not `RUNNING` |
| wave COMPLETED | both DONE → `COMPLETED` |
| unlaunchable belt | inject orphan lease held by already-FAILED A; after tick, lease freed **or** B not stuck forever |
| foreign lease wait | live lease held by another process/wave → B stays `APPROVED` this tick (not instant `unlaunchable`) |
| admit reject | dry-run + create omit verify → throw listing ids |
| admit ok | `"true"` present → dry-run `ok` |
| inspect reason | controller flip matches `/controller failed \(worker succeeded\):/` |
| fingerprint | same view → same hash; revision bump → different; `stuck` after N identical RUNNING; plan-gate does not increment |
| WR-018 belt | strip verify after create → IMPL still `missing_verify`; no land |
| quality | `npm test` 0; land also `npm run quality` 0 |

Do not weaken mutation-core lease asserts. Do not add implicit `"true"` verify in new product paths.

## 7. Touched set

**Must:** `src/core/settlement.ts`, new `src/core/lease-release.ts`, `src/core/tick.ts`, `src/core/launch.ts`, `src/core/wave-create.ts`, `src/core/wave-commands.ts`, `src/core/operator-loop.ts`, `scripts/wave-operator.sh`, `scripts/run-backlog-wave.sh`, `docs/OPERATOR-RUNBOOK.md`, `README.md`, `issues/WR-019-p0-p1-stuck-wave-recovery.md`, `plans/2026-08-16-wr-019-stuck-wave-recovery.md`, `test/wr-019-stuck-recovery.test.ts`, `test/wr-018-audit.test.ts`, `test/operator-contract.test.ts`

**May:** `src/cli/operations.ts` / `scripts/wave-cli.ts` only if preflight alias; `src/domain/errors.ts` only if a dedicated `missing_verify` helper is cleaner than `WaveError(..., "missing_verify")`.

**Must not:** ACP/git identity (WR-017), residual-allowlist (P2), plan-gate policy (P4), `SAFETY` flips, live RR wave unstick, overnight/drain enable, `releaseLease` fencing rule changes, Gateway mutate/deploy/push.

## 8. Out of scope

- P2 residual-allowlist / softer `codex_verify` (file-only follow-up OK in IMPL closeout, not this plan)
- P3 auto-land board closeout beyond WR-013/017
- P4 Crawmak plan-gate product review
- Unstick the live jammed RR wave (ops). No `wave-cli release-lease` this ticket
- Overnight / production drain / unrestricted drain
- Reopening WR-018 missing_verify design
- ACP `worker.cancel` on emergency-stop (still a listed product gap)

## 9. Loop

1. This PLAN (ACP artifact + product `plans/` copy)
2. Crawmak review → `crawmak/reviews/WR-019.md` (separate forge session; not this turn)
3. Astra stamps the product plan `APPROVED by Astra`
4. Fresh IMPL session + `npm test && npm run quality` + land + **push origin**

## Learn
- bite: none
- candidate: none
- promote: no

## Impl
Core + operator/docs landed in this worktree. Verify: `npm test`. Do not self-stamp.
