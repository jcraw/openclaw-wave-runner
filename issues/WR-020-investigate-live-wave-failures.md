---
id: WR-020
title: Investigate + fix live supervised-wave failures (stuck detector, verify false-fail, hung PLAN)
status: done
priority: crit
created: 2026-08-16
updated: 2026-08-16
source: jason
assignee: crawmak
builder: crawmak
worker: grok
preferred_model: grok
agent_eligible: true
eligibility: agent_eligible
needs_jason: false
phase: done
labels: [p0, postmortem, operator, verify, acp, stuck]
depends_on: []
related: [WR-019, WR-017, WR-018, WR-008]
verify: npm test && npm run quality
verify_command: npm test && npm run quality
worker_out_dir: tmp/workers/WR-020
plan: plans/2026-08-16-wr-020-live-wave-failures.md
worker_pid: "2985486"
---

# WR-020 — Live supervised-wave failure investigation + fixes

Jason (2026-08-16): Crawmak investigates what's making Wave Runner fail in live backlog waves, then **fixes Wave Runner** (not product jam tickets). Astra keeps draining product backlog in parallel.

## Failure set (evidence under workspace)

### 1) False `OPERATOR_STOP stuck` kills long healthy IMPL
- Waves: `BL-WR-006-20260816140320`, `PAR-board-remote_root-RRT-013-140320`, `PAR-board-rink_rush-RR-070-140320`
- Path: `~/.openclaw/workspace/projects/agent-backlog-wave-runner/tmp/batch-wr2-20260816140320/`
  and `.../tmp/batch-jam2-20260816140320/`
- Symptom: ticket `IMPLEMENTING` / outbox `LAUNCHED` / fingerprint stable while worker still running → operator exits `OPERATOR_STOP stuck` after default `STUCK_TICKS` (~20).
- Resume with `STUCK_TICKS=0` + loop often completed (WR-006, RRT-013 landed after resume).
- **Fix direction:** stuck detector must not treat in-flight LAUNCHED IMPL / active ACP task as stuck; or default STUCK_TICKS off for supervised; or advance fingerprint on heartbeat/lease renew.

### 2) RR-070 — worker IMPL succeeded, controller verify failed (retries exhausted)
- Wave: `PAR-board-rink_rush-RR-070-140320`
- Out: `.../tmp/batch-jam2-20260816140320/run/board-rink_rush/waves/RR-070/`
- `terminal.json` IMPL status `succeeded` + real diffs in worktree
- Result: `controller failed (worker succeeded): verify failed: python3 tools/codex_verify.py --path game/jams/rink_rush`
- `WAVE_VERIFY.json` often only `Command failed: bash -lc ...` with no useful stdout (lossy capture)
- Same class earlier: PP-034/RR-068 wave verify failed while direct `godot --headless -s …tests` passed (tier2 guided/warning policy + 30s headless timeout + ObjectDB leak noise).
- **Fix direction (Wave Runner side):** capture full verify stdout/stderr into WAVE_VERIFY; optional longer timeout env; distinguish product verify flake vs runner bug; do not drop output to one-line "Command failed".

### 3) MUD-037 hung in PLANNING
- Out: `.../tmp/batch-mud-20260816145205/run/prefix-MUD/waves/MUD-037/`
- 100+ ticks, still `PLANNING` / `wait-plan`, launches=1
- Blocks MUD-035 in same serial lane
- **Fix direction:** detect dead ACP/plan worker; timeout + retry/fail closed with reason; operator stop with actionable receipt (not infinite RUNNING).

### 4) Related prior (already partially fixed — do not regress)
- WR-019: release writer lease on IMPL **fail**; keep lease through verify+land on success
- WR-017: land identity / land-on-done
- Multi-ticket same writerScope starvation (prefer one ticket/wave per scope until smoke green)

## Goals
1. Root-cause writeup in `plans/` or `docs/` + `reviews/` style findings.
2. **Code fixes in openclaw-wave-runner** with tests for:
   - stuck detector vs live LAUNCHED workers
   - verify output capture / timeout knobs
   - hung PLAN stage detection / fail-closed
3. `npm test && npm run quality` green; land to main; push origin (public repo policy).
4. Do **not** rewrite product jam/mud tickets except as cited evidence paths.

## Non-goals
- Finishing RR-070 / MUD-037 product work (Astra backlog lane)
- Overnight drain / unrestricted drain enablement
