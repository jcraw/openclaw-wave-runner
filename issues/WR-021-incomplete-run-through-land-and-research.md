---
id: WR-021
title: Investigate incomplete run-through — land blocked by dirty primary, research missing_verify, no product closeout
status: done
priority: crit
created: 2026-08-17
updated: 2026-08-17
source: jason
assignee: crawmak
builder: crawmak
worker: grok
preferred_model: grok
agent_eligible: true
eligibility: agent_eligible
needs_jason: false
phase: done
worker_pid: ""
labels: [p0, postmortem, land, verify, research, closeout, operator]
depends_on: []
related: [WR-017, WR-018, WR-019, WR-020, WR-013]
verify: npm test && npm run quality
verify_command: npm test && npm run quality
worker_out_dir: tmp/workers/WR-021
plan: plans/2026-08-17-wr-021-incomplete-run-through.md
---

# WR-021 — Incomplete run-through (RRT-028/029 overnight)

Jason (2026-08-17): Crawmak investigates **why Wave Runner did not run all the way through** on the overnight supervised remote_root lane, then **fixes Wave Runner**. Product RRT tickets stay on Astra’s product lane — do not finish Remote Root in this ticket.

## Live failure set (evidence)

**Drain pack:**  
`tmp/drain-eligible-20260816235052/`

Lane: `run/board-remote_root/`  
Wave: `PAR-board-remote_root-RRT-028-235101`  
Latest tick: `waves/RRT-028/cli/tick-319.json`  
`wave.status = FAILED` · ticket `IMPLEMENTING` → **FAILED** · `nextAction: inspect`

### 1) IMPL + verify eventually green, land hard-failed on dirty primary
- Worker produced real hose-out work; CLOSEOUT exists in worktree:
  `.../worktrees/.../RRT-028/tmp/workers/RRT-028/CLOSEOUT.md`
- Verify commit on worktree: `1531f924 Verify RRT-028 (...)`
- `LAND.json` (`ok: false`):

```text
primary dirty overlaps land: game/jams/remote_root/README.md, .../AGENT.md,
.../JUICE_SPEC.md, .../UX_SPEC.md, .../RemoteRootJam.gd,
.../RemoteRootPresentation.gd, .../run_remote_root_tests.gd,
issues/BOARD.md, issues/remote_root/README.md,
issues/remote_root/RRT-028-hose-out-robot-harvest.md
```

- Primary dirt was **uncommitted RRT-017…027 literacy** (and other jam WIP) sitting on `main` while RRT-028 wave branched from post-RRT-016 SHA `4f07a87c`. Board already said RRT-017 **done** without a clean primary land of that slice at freeze time.
- Fail-closed dirty overlap is correct safety (WR-017). **Incomplete run-through** = wave ends FAILED with good product work stranded; no durable land; ticket stays `open`; operator finishes lane without recovery path.

**Fix direction (runner):**
- Pre-flight / admit: detect primary path overlap risk for `writerScope` before paid IMPL (or at land-prep), surface actionable receipt early.
- Land failure must leave a **recovery receipt** (paths, suggested operator action: commit/stash-unrelated vs rebase wave) — not only `LAND.json ok:false`.
- Optional supervised recovery stage: `REBASE_OR_RELAND` when verify green + land dirty-overlap (Jason/policy gated is fine; must not silent-stash).
- Board/`status: done` vs primary content drift is a product hygiene smell — runner should not treat board-done as “primary clean.”

### 2) RRT-029 never admitted — `missing_verify`
- Lane log end:

```text
WaveError: missing_verify: RRT-029
at assertTicketsHaveVerify (wave-create.js)
FAIL RRT-029
=== lane board-remote_root end 2026-08-17T01:59:47-07:00 ===
```

- Ticket is **research** (`needs: research_digest`, LoC topic `mobile-worker-harvest-automation`) with empty `verify_command: ""`.
- WR-019 correctly fail-closes empty verify at create. **Gap:** research/spike tickets cannot enter a supervised lane without a real verify contract, and the drain selector still queued RRT-029 behind RRT-028.
- Drain reported `ALL LANES FINISHED` while RRT-029 never ran and RRT-030/031 never started.

**Fix direction (runner + admit):**
- Research/spike profile: allow an explicit non-empty research verify (e.g. digest path exists / NOTE+READY written) **or** a typed `verify_kind: research|noop` that is validated and recorded — never silent empty string.
- Drain/eligible selector must not enqueue tickets that will fail `missing_verify` at create; fail at select time with ticket id + reason.
- Serial lane should continue or clearly terminal-split when ticket N+1 is inadmissible (don’t strand the rest with a create error only).

### 3) “Lane finished” ≠ product done
- `drain.log`: `ALL LANES FINISHED 2026-08-17T02:12:11-07:00`
- Product truth after finish: RRT-028 still `open`, worktree retained, no primary land, research queue untouched.
- Operator success signal over-claims.

**Fix direction:**
- Terminal summary must list per-ticket terminal state (DONE land ok / FAILED reason / SKIPPED missing_verify).
- Non-zero exit when any ticket in the kicked list is not DONE (unless policy says best-effort).
- Closeout debt detector: COMPLETED/FAILED-with-green-impl without `land.ok` → explicit `CLOSEOUT_DEBT` state (related WR-017/013).

### 4) Related prior — do not regress
- WR-017 land dirty-overlap fail-closed (keep)
- WR-019 missing_verify at create (keep; extend for research)
- WR-020 stuck detector / verify capture (keep)
- WR-013 land-on-done (keep; DONE only with land proof)

## Goals
1. Root-cause writeup in `plans/` (+ short `docs/` note if lasting).
2. **Code fixes in openclaw-wave-runner** with tests covering:
   - land dirty-overlap recovery receipt / non-success terminal clarity
   - research/spike verify contract OR select-time reject of empty verify
   - drain/lane terminal summary honesty (finished ≠ all DONE)
   - optional: pre-land or admit overlap warning for writerScope paths
3. `npm test && npm run quality` green; land to main; **push origin** (public repo).
4. Do **not** implement Remote Root product (RRT-028 hose-out) here — cite paths only.

## Non-goals
- Finishing RRT-028/029/030/031 product or LoC research (Astra product lane)
- Re-enabling overnight / unrestricted drain / LLM re-drain loops
- Weakening dirty-primary fail-closed into silent stash

## Evidence pointers
- Wave ticks: `.../waves/RRT-028/cli/tick-319.json` (and earlier verify-retry ticks)
- Worktree CLOSEOUT + LAND.json under RRT-028 wave dir
- Lane log: `.../run/board-remote_root/lane.log`
- Drain log: `.../drain-eligible-20260816235052/drain.log`
- Tickets: jam `issues/remote_root/RRT-028-*.md`, `RRT-029-*.md`

## Acceptance
- [x] Plan + Jason stamp (`APPROVED by Jason 2026-08-17`)
- [x] Failing cases above have regression tests or golden receipts
- [x] `npm test && npm run quality` 0
- [x] Landed + pushed; ticket `status: done` with CLOSEOUT
- [x] Runbook note: how research tickets must declare verify; how land dirty-overlap is recovered
