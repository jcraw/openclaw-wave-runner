---
id: WR-035
title: Honor hybrid plan_worker — Codex ACP for PLAN, Grok for IMPL
status: open
priority: high
created: 2026-08-24
updated: 2026-08-29
source: jason
assignee: crawmak
builder: crawmak
worker: grok
preferred_model: grok
agent_eligible: true
eligibility: agent_eligible
needs_jason: false
phase: impl
labels: [hybrid, plan-worker, acp, codex]
depends_on: [WR-037]
related: [WR-028, WR-033, WR-037]
verify: npm test && npm run quality
verify_command: npm test && npm run quality
worker_out_dir: tmp/workers/WR-035
plan: plans/2026-08-29-wr-035-honor-hybrid-plan-worker.md
land: commit
---

# WR-035 — Honor hybrid `plan_worker`: Codex ACP PLAN, Grok IMPL

Freeze-time hybrid / `plan_worker` is ignored at launch. `intentFromOutbox` hard-codes Grok except Mona `UX_REVIEW`. House hybrid tickets therefore PLAN on Grok.

## Goals

1. Canonical freeze field `planWorker` (`grok` | `codex`). YAML `plan_worker` / `planWorker`; JSON `planWorker` / `plan_worker`. Normalize `grok`/`grok-acp` → `grok`, `codex`/`codex-acp` → `codex`. Do not infer from labels, assignee, `planClass`, or `preferred_model`.
2. YAML `worker: hybrid` / JSON `provider: "hybrid"` with **no** `plan_worker` implies Codex PLAN. Explicit `plan_worker` wins.
3. Launch agent: `UX_REVIEW` → `mona`; `PLAN` + `planWorker === "codex"` → `codex`; every other stage including IMPL, FIX, VERIFY, REVIEW → `grok` even if `worker`/`provider` is `hybrid` or `codex`.
4. Unknown `plan_worker` is `unknown_plan_worker` at dry-run (`admitBlockers`) and create (throw, `missing_verify` shape). Snapshot of a mixed board must not throw.
5. Codex PLAN cwd is the isolated product impl worktree. OpenClaw spawn `agentId: "codex"`, `runtime: "acp"`. No `timeoutSeconds`. No Codex CLI adapter.
6. Codex receipts: `provider: "codex-acp"` on launch **and** recover. Do not stamp `model: grok-4.6`. Grok/Mona receipts stay `grok-acp`.
7. `GrokCliWorker` refuses `agentId === "codex"` on launch and `provider === "codex-acp"` on inspect. Message names Codex PLAN. IMPL grok CLI still allowed. Missing ACP spawn stays fail-closed. No Grok fallback if Codex `sessions_spawn` is refused.
8. Skip `WAVE_READ_FILE_HANG_MS` when `receipt.provider === "codex-acp"`. `WAVE_PLAN_WALL_MS` still owns Codex PLAN.
9. Schema v6: `ticket_runs.plan_worker TEXT`. Manifest schema stays 1. `contentHash` does not include `planWorker`. Per-provider admission still keys off ticket `provider`.
10. `npm test && npm run quality` green. Land `commit`. No push / merge / Gateway.

## Tests (named contracts)

See `test/wr-035-plan-worker.test.ts` and the Codex spawn case in `test/openclaw-acp.test.ts`.

## Non-goals

- Routing IMPL to Codex, `impl_worker`, Kawazaki, Robin
- Codex CLI / `codex` binary launcher
- Splitting `perProviderConcurrency` into Codex vs Grok buckets
- Changing Crawmak REVIEW cwd/agent, Mona UX_REVIEW, skip-bit, human hold
- OpenClaw Gateway methods or host `codex` agent config (document the id only)
- SAFETY / drain / overnight / push / merge
