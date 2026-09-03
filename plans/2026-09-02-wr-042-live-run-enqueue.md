# Plan: one live run, enqueue slices (do not mutate freeze)

Target: `openclaw-wave-runner`
Verify: `npm test && npm run quality`
Not a token cap on PLAN/IMPL/REVIEW. Orchestration stays no-LLM.

## Why it felt brittle

A **wave** is an immutable ticket batch (ADR-001 / README invariant 1: tickets added after freeze never enter that wave). That freeze is what keeps the scheduler a 20s bash tick instead of a 51M-token LLM drain.

What actually broke on 2026-09-02 was not freeze. Each `run-backlog-wave.sh` starts a **second operator process** with its own `WAVE_ID` and tick loop. Writer leases already share a per-repo sqlite (`WR-026`). **ACP slots do not.** `perProviderConcurrency=5` is counted **inside one wave’s outbox**. Three nohups (RRT hopper + SL + MUD) each thought they owned 5 Grok ACP sessions. OpenClaw’s real cap is 5 **global**. Cancel + three new waves at 16:04 then paid PLAN/REVIEW again on `ACP_TURN_FAILED`.

So: you do not need one giant mutable wave. You need **one live run**. “Kick more tickets” must **enqueue**, not spawn a rival controller. Internally that enqueue is still a frozen slice (deps, baseSha, worktrees, cancel blast radius). You should never have to think about the slice id.

If we literally stuffed every ticket into one frozen manifest, today’s **wave-level cancel** would kill the siblings (RRT-134 died because the hopper was cancelled). Merge at the **run**, not the manifest.

## Goal

Jason kicks tickets whenever. They join the live pipeline. Each ticket still does PLAN → Crawmak review → fresh IMPL → named verify → land. Zero LLM in the operator. No extra PLAN because we recreated a wave. No cap on worker tokens.

## Shape

```
Jason: REPO=… TICKETS=A,B run-backlog-wave.sh
        │
        ├─ no live supervisor → start supervisor (nohup, pid at $WR_SCRATCH/supervisor.pid)
        └─ live supervisor    → freeze a new SLICE in the repo ledger, return. supervisor ticks it.
```

- **Run** = one no-LLM supervisor, one ACP pool, pid file, ticks until the queue is idle.
- **Slice** = today’s wave row (`create` + `freeze` + `start` records). Immutable.
- **Enqueue** = `create` another slice in the same (or other) repo ledger. Do not start a second tick loop.
- **ACP lease** = machine-global (`$WR_SCRATCH/ledgers/acp.sqlite` or a row in a small `run.sqlite`), not per-slice. Admit a Grok/Codex/Crawmak session only if `active < ACP_SLOTS` (default 4, leave 1 for interactive). Cross-repo (jam + mud) share it.

Supervisor `tick` becomes: for each non-terminal slice in every known repo ledger, `tick(waveId)` **or** a new `tick-run` that already walks `listWaves()`. Admission for ACP uses the global slot, not `listOutbox(thisWaveId)`.

`drain-eligible.sh` / `run-backlog-parallel.sh` must go through the same supervisor. Today parallel lanes already spawn **one wave per ticket** (`TICKETS="$ticket"`). That is fine as slices; it is not fine as N nohups.

## Stage resume (orchestration, not worker caps)

When enqueueing ticket `T`:

1. Forge `reviews/T.md` Verdict `approve` | `approve-with-conditions` **and** a `PLAN.md` on disk → skip PLAN+REVIEW, queue IMPL with that plan path (same contract as an in-wave admit).
2. `PLAN.md` exists, no approve → skip PLAN, queue REVIEW.
3. IMPL verify failed with `WAVE_VERIFY.json` → FIX IMPL (`land-retry` / existing rearm), never PLAN.
4. Same ticket already `PLANNING`/`IMPLEMENTING` in a live slice → **no-op enqueue** (print the live wave/stage). Do not start a twin.

Lookup order: live ledger row for `T` (any non-terminal wave) → latest `planArtifact` + forge review. Do not re-hash the ticket into a greenfield PLAN because the old waveId was `CANCELLED`.

This is the MUD-052 / SL-007 / RRT-133 retry waste.

## Do not LLM-retry host or gate fails

Extend `stageDeathNoRetry` (`src/core/settlement.ts`) beyond Codex PLAN:

- Grok `ACP_TURN_FAILED` / `Internal error` / `connection_close` → **no auto-retry**. Ticket stays at that stage (`PLAN_REVIEW` / `APPROVED` / `REVISING`) with the reason. Supervisor keeps ticking other work. Operator re-enqueues **same stage** when ACP is healthy.
- `plan_artifact: plan missing verify command` → already non-retryable inside a wave. Add `wave-cli recheck-plan --wave W --ticket T`: re-read `PLAN.md`, run `checkPlanArtifact`, admit if it now contains the exact `verifyCommand`. **No new PLAN session.** SL-004’s 10:09 file already had the string; settle likely raced the file vs ACP summary.

`maxRetriesPerStage=2` stays for **product** death (empty worker, verify red → FIX IMPL).

## Cancel is per ticket, not per run

New: `wave-cli cancel --wave W --ticket T` (or `--ticket T` resolved via live run). Sticky on that ticket only. Supervisor stays up. Dependent tickets in the same slice stay blocked (today’s dep rule: FAILED/CANCELLED deps do not satisfy). Other slices unaffected.

Wave-level `cancel` remains for “kill this slice.” It must **not** be the default when Jason is just tired of one ticket. `emergency-stop` still kills every non-terminal slice.

## Pipeline / freeze hygiene (keep)

- PLAN ≠ IMPL session. Handoff = plan artifact + Crawmak verdict.
- `dependsOn` from ticket YAML at freeze (already `markdown-tracker.ts`). Dry-run **prints** the frozen graph. First SL-006/007 freeze had `dependsOn: []` because YAML did not have `depends_on` yet — WR was honest. Optional warn: two tickets in one enqueue with the same `game:` and a `parent:` / later `depends_on` — do not invent edges.
- `missing_verify` stays dry-run fail-closed (0 LLM). Good.
- `maxTokens` / 8k `INDETERMINATE` reservation: **leave it**. Do not use it to stop PLAN/IMPL. Orchestration budget is **wasted launches** (stage hop that does not land, same ticket/stage attempt>1 on host error, PLAN after an existing approve).
- `maxLaunches` stays a **slice** hop ceiling so one freeze cannot be 40 tickets. Enqueue another slice instead of raising it. Default 48 is enough for ~8 tickets × PLAN+REVIEW+IMPL.

## What we will not do

- Live-mutate a frozen manifest (reopens LLM-scheduler / “queue changed under us”).
- Cap worker tokens or wait on a usage DTO (WR-009: ACP has no meters).
- LLM orchestrator, unprompted re-drain, overnight poll.
- One cancel blasting every product on the machine.

## Ticket cut (implement in this order)

File as WR-042… in `openclaw-wave-runner` (next ids after WR-041). One slice per ticket; each is plan-review-impl.

### WR-042 — Supervisor + enqueue + global ACP slot
The merge Jason asked for.

- `$WR_SCRATCH/supervisor.pid` + `run.sqlite` (or equivalent): live run, ACP reservations `{provider, sessionId, waveId, ticketId, stage}`.
- `queueStage` ACP check: count **global** in-flight Grok/Codex/Crawmak, not `listOutbox(waveId)`.
- `wave-cli enqueue` / `run-backlog-wave.sh`: if supervisor alive, freeze slice + return; else spawn supervisor.
- Supervisor ticks all non-terminal waves across repo ledgers it knows (jam + mud + wr). Idle with empty queue: stay up for `WAVE_IDLE_EXIT_S` (default 30m) then exit, or until `stop`.
- `run-backlog-parallel.sh` enqueues lanes; does not nohup per ticket.
- Tests: two enqueues, one pid; second process does not `sessions_spawn` a twin operator; ACP slot denies 5th concurrent; disjoint writer scopes still IMPL in parallel **if** ACP slots remain.

### WR-043 — Continue from last good stage
Depends on WR-042 (enqueue is the seam).

- Enqueue of ticket with forge approve + PLAN.md → IMPL only.
- PLAN.md, no approve → REVIEW only.
- Live duplicate → no-op.
- Cancelled slice artifacts still count (path + verdict file), so recreate is not required.
- Tests: fixture PLAN+review → zero PLAN launches; cancelled wave then enqueue IMPL uses same plan path.

### WR-044 — Host/gate fails are not PLAN retries
Can parallel WR-043.

- `stageDeathNoRetry` for Grok ACP host errors (all stages).
- `recheck-plan` CLI + settle path prefers `outputDir/PLAN.md` over truncated ACP summary (SL-004 race).
- Tests: ACP Internal error does not rearm PLAN/REVIEW/IMPL; missing-verify plan that later contains the string admits without a new stage_run.

### WR-045 — Ticket-level cancel
Can parallel WR-043; wanted before people treat the run as “one wave.”

- Cancel one ticket; supervisor + other slices keep going.
- Deps in-slice still block.
- Tests: two-ticket slice, cancel T2, T1 lands.

## Operator now (before code)

Stop the live recoveries if they are re-PLANning approved work (`RRT-133-134-recovery`, `MUD-052-recovery`). Do not kick a third product nohup. Until WR-042 lands: **one** `run-backlog-wave.sh` at a time. Resume MUD-052 / SL-007 from existing `reviews/*.md` by hand if you must move tonight.

## Files (WR-042 core)

- `src/core/admission.ts` — global ACP lease, not per-wave outbox count
- `src/core/tick.ts` / new `src/core/run-supervisor.ts` — tick all live slices
- `src/core/wave-create.ts` + `src/cli/operations.ts` + `scripts/wave-cli.ts` — `enqueue`
- `scripts/run-backlog-wave.sh` — join-or-spawn
- `scripts/run-backlog-parallel.sh` / `scripts/drain-eligible.sh` — enqueue only
- `src/store/schema.ts` — ACP/run tables if not a sidecar sqlite
- `docs/OPERATOR-RUNBOOK.md` + `README.md` — “run vs slice”; stop telling Jason to create isolated waves
- `test/wr-042-enqueue-supervisor.test.ts` (name follows id)

## Acceptance (campaign)

- Second `TICKETS=… run-backlog-wave.sh` while a run is live: new slice, **same supervisor pid**, no second nohup, tickets enter PLAN/REVIEW/IMPL in the normal pipeline.
- Jam + MUD slices share ACP slots; 5th session defers, does not `connection_close` the others.
- Re-enqueue of an approved ticket does not launch PLAN or REVIEW.
- ACP Internal error does not burn `maxRetriesPerStage`.
- Cancel of one ticket does not cancel the run.
- `npm test && npm run quality` green; no worker token ceiling added.

## Learn

- bite: other:wave-vs-run
- candidate: freeze is the cheap scheduler; the expensive bug is a second operator process, not a second frozen list
- promote: no (until WR-042 lands; then OPERATOR-RUNBOOK)
