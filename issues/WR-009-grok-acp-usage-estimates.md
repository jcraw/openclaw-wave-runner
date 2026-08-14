---
id: WR-009
title: Spike — Grok ACP stage token usage estimates
status: open
priority: medium
created: 2026-08-14
updated: 2026-08-14
source: jason
agent_eligible: true
eligibility: agent_eligible
depends_on: []
verify: test -s tmp/workers/WR-009/SPIKE.md
labels: [spike, usage, acp, budget]
phase: spike
---

# WR-009 — Spike: Grok ACP usage estimates

## Problem
Wave Runner settles Grok ACP stages via `FailClosedUsage`: public Task Run / ACP receipts have **no token fields**, so every stage stays **`INDETERMINATE`** at the full per-stage reservation (today 8k).

OpenClaw Grok ACP session transcripts also show `provider: openclaw` / `model: acp-runtime` with **usage all zeros** — the bridge does not surface real Grok meters.

Jason wants a path to **estimates** for Grok ACP work (dashboard / operator sense of spend), without lying about billing-grade actuals.

## Spike question
What is the best **honest** way to report Grok ACP stage cost, ranked by truthfulness?

1. Authoritative usage from Grok / xAI / ACP / OpenClaw DTO?
2. If not: best **estimate-only** signal that can be attached without becoming `COMMITTED`?
3. What should Wave Runner change vs what must be upstream OpenClaw/ACP/Grok?

## In scope (research + write-up only)
- Probe current surfaces:
  - `FailClosedUsage` + `UsageAdapter` / settlement path
  - Launch receipts / `terminal.json` / stage artifacts
  - OpenClaw Task Run public DTO / gateway inspect
  - Grok ACP agent session jsonl (`usage` blocks)
  - Grok CLI (`/home/j/.local/bin/grok`) flags/logs for any token printout
  - xAI console / account aggregates (note only; no scraping secrets)
- Document each signal: available? authoritative? stage-attributable? how to read it
- Recommend one of:
  - **A.** Keep fail-closed only (no estimate)
  - **B.** Estimate-only field (`estimatedTokens`, confidence) — budget still INDETERMINATE/reserve
  - **C.** Wire real usage when a proven public contract exists
- Sketch minimal WR follow-on ticket(s) if B or C
- Write `tmp/workers/WR-009/SPIKE.md` with verdict + evidence paths

## Out of scope
- Implementing settlement changes in this ticket (spike only)
- Faking `COMMITTED` from guesses
- Changing reservation defaults / supervised caps
- Overnight / drain / merge / push product waves
- Spending large Grok runs solely to sample meters (prefer existing session logs + dry probes)
- Touching OpenClaw core unless the spike proves a one-line public API already exists (then note PR target; do not ship here)

## Acceptance
- [ ] `tmp/workers/WR-009/SPIKE.md` exists with:
  - ranked findings table (signal → truth → stage-linkable → effort)
  - clear verdict A / B / C (+ hybrid if needed)
  - “do not commit estimates as actual” rule restated if B
  - optional draft WR-010 acceptance bullets if implementation is justified
- [ ] No product runtime change required for spike close (docs/spike artifact only)
- [ ] Spike ends **needs Jason** for go/no-go on any impl ticket (do not auto-file impl unless Jason said so — leave draft text in SPIKE only)

## Agent notes
- Public package: work in repo worktree; spike artifact under `tmp/workers/WR-009/` (gitignored ok)
- Prefer reading existing MUD/RRT Grok ACP session logs over new paid runs
- Cap SPIKE.md ~2–4 screens; no novel architecture essay
- After spike: set ticket `status: done` only for the research deliverable; call out Jason gate for impl in CLOSEOUT/SPIKE
