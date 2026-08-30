# WR-035 plan — Honor hybrid `plan_worker`: Codex ACP for PLAN, Grok for IMPL

**Ticket:** `issues/WR-035-hybrid-codex-plan-acp.md`
**Verify:** `npm test && npm run quality`
**Land:** commit this worktree (no push / merge / Gateway from this ticket)
**Author:** `JCraw <4335668+jcraw@users.noreply.github.com>`

House BOARD already prints `open · hybrid · high` (WR-036). Freeze already maps YAML `worker:` onto `FrozenTicket.provider`. Launch does **not** read either field for the ACP agent: `intentFromOutbox` hard-codes `agentId: item.stage === "UX_REVIEW" ? "mona" : "grok"` (`src/core/launch.ts`). YAML `plan_worker` is not ingested. Product PLAN and IMPL therefore always spawn Grok ACP, including tickets that asked for Codex PLAN.

## Problem

1. Markdown ingest sets `provider` from `worker` and ignores `plan_worker` (`src/adapters/markdown-tracker.ts`). JSON ingest has the same hole (`src/adapters/json-tracker.ts`).
2. `LaunchIntent.agentId` and `AcpSpawnRequest.agentId` are `"grok" | "mona"` only. There is no `"codex"`.
3. `GrokAcpWorker` always stamps receipt `provider: "grok-acp"` / `model: grok-4.6`.
4. `GrokCliWorker` (`--launcher`) would run a Grok planning phase for a hybrid PLAN. UX_REVIEW already refuses the CLI fallback; Codex PLAN must too.
5. A Codex spawn failure must **not** retry Grok. Silent substitute is the current defect.

Crawmak `REVIEW` and Mona `UX_REVIEW` stay as WR-028 / WR-037. Hybrid routing is PLAN vs IMPL product workers only.

## Goal

Freeze-time hybrid / `plan_worker` is honored at launch:

```
PLAN  (fresh ACP, isolated product worktree) → Codex when hybrid/plan_worker says so
  → Crawmak REVIEW (forge, grok) unchanged
  → optional Mona UX_REVIEW unchanged
IMPL  (fresh ACP, isolated product worktree) → Grok
```

Missing `plan_worker` on a non-hybrid ticket keeps today’s Grok PLAN. No Gateway protocol change. `sessions_spawn` already forwards `agentId`; OpenClaw host must have a `codex` ACP agent or spawn fails closed.

## Decisions

| # | Pick |
|---|---|
| D1 | Canonical freeze field `planWorker` (`"grok" \| "codex"`). YAML `plan_worker` / `planWorker`; JSON `planWorker` / `plan_worker`. Normalize `grok`/`grok-acp` → `grok`, `codex`/`codex-acp` → `codex`. Do **not** infer from labels, assignee, `planClass`, or `preferred_model`. |
| D2 | House shorthand: YAML `worker: hybrid` (JSON `provider: "hybrid"`) with **no** `plan_worker` implies `planWorker: "codex"`. Explicit `plan_worker` wins over the shorthand (so `worker: hybrid` + `plan_worker: grok` is Grok PLAN). |
| D3 | Launch agent: `UX_REVIEW` → `mona`; `PLAN` + `planWorker === "codex"` → `codex`; every other stage including IMPL, REVIEW, VERIFY → `grok`. IMPL is Grok even when `worker`/`provider` is `hybrid` or `codex`. This ticket is not a general IMPL router. |
| D4 | Unknown `plan_worker` is `unknown_plan_worker` at dry-run (`admitBlockers`) **and** create (throw, same shape as `missing_verify`). Do not freeze a ticket whose PLAN agent cannot be routed. |
| D5 | Codex PLAN cwd is the isolated **product** impl worktree (`launchCwd` already returns `ticket.implWorktree` for PLAN). Do not invent a Codex home. Forge/Mona cwd rules unchanged. |
| D6 | OpenClaw spawn: `agentId: "codex"`, `runtime: "acp"` (existing `mona ? subagent : acp` already does this). No `timeoutSeconds`. No Codex CLI adapter. |
| D7 | `GrokAcpWorker` receipt: Codex PLAN `provider: "codex-acp"`; do not stamp `model: grok-4.6` on Codex. Grok/Mona receipts stay as they are. Recover uses the same `intentFromOutbox`, so crash-adopt stays Codex. |
| D8 | `GrokCliWorker` refuses `agentId === "codex"` (and keep the UX_REVIEW refuse). Message names Codex PLAN, not UX. No Grok CLI planning phase for hybrid. Missing ACP spawn stays fail-closed (`MissingAcpSpawnWorker`). **No Grok fallback** if Codex `sessions_spawn` is refused. |
| D9 | `WAVE_PLAN_WALL_MS` still owns Codex PLAN. Skip `WAVE_READ_FILE_HANG_MS` when `receipt.provider === "codex-acp"` (that detector reads `~/.grok/sessions`). |
| D10 | Schema v6: `ticket_runs.plan_worker TEXT`. `ticketFromFrozen` / `putTicket` / `mapTicket` persist it. Manifest schema stays **1**. `contentHash` does **not** include `planWorker`. Per-provider admission still keys off ticket `provider` (YAML `worker`); do not split Codex vs Grok caps here. |
| D11 | REVISING re-queues PLAN; same frozen `planWorker` applies. Crawmak REVIEW stays grok / forge. Skip-bit / human hold / `needs_ux` untouched. |

Board slug is `issues/WR-035-hybrid-codex-plan-acp.md` (Crawmak review condition: do not add a second honor-hybrid issue file).

## Verify

`npm test && npm run quality` on this worktree HEAD. Named new tests in `test/wr-035-plan-worker.test.ts` plus the Codex case in `test/openclaw-acp.test.ts`. Existing `test/wr-037-ux-review.test.ts` (REVIEW grok / UX mona / CLI refuses UX) and grok PLAN tickets must stay green.

## Learn

- bite: none
- candidate: `intentFromOutbox` hard-coded grok except Mona; YAML `worker`/`plan_worker` never reached ACP `agentId`, so hybrid house tickets planned on Grok
- promote: no
