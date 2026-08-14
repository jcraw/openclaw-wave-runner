# OpenClaw Wave Runner

**Bounded backlog execution for expensive coding agents.**

Freeze a ticket set. Reserve budget before every launch. Run plan → approve → **fresh** implement. Terminate with proof — not vibes, not “keep going until empty.”

> Status: **v0.1** — deterministic core + OpenClaw plugin adapters are real and tested.  
> **Unrestricted / overnight / production drain stay fail-closed off.** Supervised 1–3 ticket waves only.

---

## The problem this solves

Agent stacks got good at *doing work*. They stayed bad at *stopping*.

A common pattern looks productive:

1. Point an LLM at a markdown board or issue list  
2. Tell it to “clear the backlog” / “keep draining”  
3. Let it re-scan the queue, approve itself, spawn workers, and re-arm a cron  

That pattern fails in predictable ways:

| Failure | What happens |
|--------|----------------|
| **Live mutable queue** | Tickets appear mid-run; the wave never had a fixed job |
| **LLM as scheduler** | Every “worker still live; wait” costs a full model turn |
| **No spend ceiling** | Tokens/cost grow without a hard refuse-at-admission point |
| **Same session forever** | Plan chat bleeds into impl; repair resumes the wrong context |
| **Soft concurrency** | “Serial per repo” in a prompt ≠ a fenced writer lease |
| **False green** | Path-verify or self-reported done without independent settle |
| **No terminal proof** | Runs end because the model got bored, the process died, or the bill hurt |

In one real incident, two overlapping “clear backlog” control loops spent on the order of **~51M recorded tokens in ~9 hours**, mostly cache reads from the *scheduler* re-reading the world — not from useful implementation work. The architecture was wrong, not just the cron interval.

**Wave Runner is the control plane that should have been there:** a small deterministic controller above your agent runtime, not another chatty orchestrator agent.

---

## What it is

An **OpenClaw plugin** plus a **host-agnostic core** that turns “selected tickets” into a **wave**:

```text
explicit start
    → freeze immutable manifest (ticket ids, deps, limits, hash)
    → admit under budgets + repo writer lease
    → PLAN (fresh worker)
    → approve / revise / block
    → IMPL (fresh worker, isolated worktree)
    → verify / settle
    → next admitted ticket or TERMINAL summary
```

Markdown boards (or other trackers later) are **adapters** — intent in, status projected out.  
They are **not** the transactional runtime. The wave ledger is.

### Invariants (the product)

1. Tickets added after freeze **never** enter that wave  
2. No expensive launch without a **committed reservation**  
3. One fenced **writer lease** per repository  
4. One launch per `{wave, ticket, stage, attempt}` idempotency key  
5. Plan session ≠ impl session (handoff = **approved plan artifact**)  
6. Missing usage → fail closed / retain reservation as `INDETERMINATE`  
7. Cancellation is sticky across restarts  
8. Every wave **terminates** (exhaustion, budget, deadline, cancel, or block)  
9. No normal progress path that is “poll the LLM every N minutes”  

---

## What it is not

- Not a replacement for GitHub Issues / Linear / Jira  
- Not OpenClaw **Workboard** (Kanban + dispatch UI — complementary; optional projection)  
- Not a generic multi-agent framework or “crew” runtime  
- Not “run until the board is empty”  
- Not Temporal/Prefect (you can put a similar controller *on* those later; v0 is OpenClaw-native)

If you want unbounded autonomous drain, this package will refuse you. That’s the point.

---

## How it compares

| | Workboard (bundled) | “LLM drain cron” | **Wave Runner** |
|--|---------------------|------------------|-----------------|
| Job definition | Live cards | Whatever the model sees now | **Frozen manifest** |
| Scheduler | Gateway dispatch | The model | **Deterministic controller** |
| Budgets | Soft / batch size | Hope | **Hard admission** |
| Repo safety | Policy-dependent | Prompt | **Writer lease + worktrees** |
| Lifecycle | Card status | Chat memory | **Plan → approve → fresh impl** |
| Stop condition | Operator / empty-ish queue | Never, really | **Always terminal** |

---

## Install (OpenClaw)

Requires **OpenClaw ≥ 2026.7.1** and Node **≥ 22**.

**ClawHub:** https://clawhub.ai/jcraw/openclaw-wave-runner

```bash
openclaw plugins install clawhub:@jcraw/openclaw-wave-runner
```

npm package name is the same (`@jcraw/openclaw-wave-runner`) once published to the npm registry.

**From source:**

```bash
git clone https://github.com/jcraw/openclaw-wave-runner.git
cd openclaw-wave-runner
npm install
npm run quality   # hygiene + types + coverage + proof + pack shape
openclaw plugins install -l "$PWD"
openclaw gateway restart
```

Plugin id: `wave-runner-m0`. Exact install flags follow your OpenClaw version — see [Building plugins](https://docs.openclaw.ai/plugins/building-plugins).

---

## Quick start (CLI, simulate)

No paid workers — exercises freeze → admit → mock stages:

```bash
npm run cli -- capabilities
npm run cli -- dry-run --wave W1 --repo /path/to/repo --tickets T-001
npm run cli -- create --wave W1 --repo /path/to/repo --tickets T-001
npm run cli -- start --wave W1 --simulate
npm run cli -- inspect --wave W1
```

Supervised real-worker path (1–3 tickets, isolated worktrees, hard caps, **explicit operator ticks**):

```bash
npm run cli -- create --wave W1 --repo /path/to/repo --tickets T-001 \
  --supervised --worktree-root /tmp/wave-worktrees \
  --max-launches 4 --max-tokens 48000 --max-wall-ms 1200000

npm run cli -- start --wave W1 --repo /path/to/repo --supervised \
  --worktree-root /tmp/wave-worktrees --artifact-root /tmp/wave-artifacts

npm run cli -- tick --wave W1 --repo /path/to/repo --supervised \
  --worktree-root /tmp/wave-worktrees --artifact-root /tmp/wave-artifacts
```

See [`docs/OPERATOR-RUNBOOK.md`](docs/OPERATOR-RUNBOOK.md).

Gateway methods (when the plugin is loaded): `wave_runner.*` and compatibility `wave_runner_m0.*`.

---

## Ticket shape (markdown adapter)

Wave Runner reads YAML-frontmatter markdown tickets (git-native boards). Minimal fields:

```yaml
---
id: T-001
title: Short title
status: open
depends_on: []          # optional
agent_eligible: true    # optional filter
---

## Problem
...

## Acceptance
- [ ] ...
```

Boards are great for humans and agents. **Waves** are great for machines that spend money.

---

## Architecture (short)

```text
┌─────────────────────────────────────────────┐
│  Tracker adapter (markdown today)           │
│  select + normalize → hash into manifest    │
└────────────────────┬────────────────────────┘
                     ▼
┌─────────────────────────────────────────────┐
│  Wave ledger (plugin SQLite)                │
│  Wave · TicketRun · StageRun · Budget · Lease│
└────────────────────┬────────────────────────┘
                     ▼
┌─────────────────────────────────────────────┐
│  Controller (deterministic)                 │
│  state machine · admission · outbox · settle│
└────────────────────┬────────────────────────┘
                     ▼
┌─────────────────────────────────────────────┐
│  Host adapters                              │
│  OpenClaw Task Flow · ACP workers · CLI     │
└─────────────────────────────────────────────┘
```

Design notes: [`docs/ADR-001-frozen-wave-authority.md`](docs/ADR-001-frozen-wave-authority.md).

Core modules live under `src/core/` and `src/domain/` and are written to stay separable from OpenClaw if another host appears later.

---

## Safety defaults

Hard-coded **off** until an operator deliberately changes policy *and* the code gates allow it:

- unrestricted “drain everything”  
- recurring LLM backlog polling  
- overnight autonomous execution  
- production drain mode  
- deploy/push from the runner  
- active Gateway restart/config mutation from the runner  

Supervised mode caps: **≤3 tickets**, launch/token/wall ceilings, **repo concurrency = 1**, isolated worktrees.

Emergency stop cancels non-terminal waves and fail-closes reserved spend.

---

## Development / quality gates

```bash
npm run quality
# = hygiene (no host paths/secrets)
# + typecheck (strict TS)
# + test:coverage (c8 thresholds: lines/statements ≥80, branches ≥60, funcs ≥75)
# + proof harness
# + npm pack shape check (JS entrypoints, no src/tests in tarball)
```

Individual targets: `test`, `test:coverage`, `proof`, `hygiene`, `pack:check`.

CI runs `npm run quality` on every push/PR (`.github/workflows/ci.yml`).

---

## Project status / roadmap

- [x] Frozen manifest + content hash  
- [x] Budget reservation / reconciliation model  
- [x] Repo writer leases  
- [x] Plan → approve → fresh impl state machine  
- [x] Markdown tracker adapter  
- [x] OpenClaw Task Flow + ACP worker adapters  
- [x] Supervised CLI path + fail-closed safety gates  
- [x] Property + fault injection tests  
- [ ] Broader multi-repo production hardening  
- [ ] Optional Workboard projection adapter  
- [ ] ClawHub package + semver stability  
- [ ] Non-OpenClaw host adapter (only if demanded)  

---

## Why open source this?

Because the industry is about to repeat the same drain-loop mistake at scale, and the fix is **boring control theory**, not a cleverer prompt.

If you run coding agents against a backlog: **freeze the work, meter the spend, fence the repo, terminate with proof.**

---

## License

Apache-2.0 — see [LICENSE](LICENSE).

## Contributing

Issues and PRs welcome. Please keep PRs focused on the controller invariants and tests; new “just let it keep going” modes will be rejected.

## Disclaimer

This software can launch coding agents that modify repositories and spend provider budget. Defaults are conservative; you are responsible for how you enable workers, credentials, and merge policy on your machines.
