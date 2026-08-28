---
id: WR-037
title: Mona UX_REVIEW stage — after Crawmak, before stamp, gated needs_ux
status: open
priority: high
created: 2026-08-27
updated: 2026-08-27
source: jason
assignee: crawmak
builder: crawmak
worker: grok
preferred_model: grok
agent_eligible: true
eligibility: agent_eligible
needs_jason: false
phase: planning
labels: [plan-gate, review, mona, ux, specialist]
depends_on: [WR-028]
related: [WR-008, WR-023, WR-028]
verify: npm test && npm run quality
verify_command: npm test && npm run quality
worker_out_dir: tmp/workers/WR-037
land: commit
---

# WR-037 — Mona UX review as a gated Wave Runner stage

Jason 2026-08-27: Dustcrawl art/UX director is OpenClaw agent **`mona`**. Do **not** run her on every ticket. Add a WR stage for UX spec review in the existing plan-gate spine.

Current default (WR-028):

```
PLAN → Crawmak REVIEW → stamp → IMPL
```

Wanted when the ticket has a UX surface:

```
PLAN → Crawmak REVIEW → Mona UX_REVIEW → stamp → IMPL
```

Skip Mona when there is no UX spec create/update (engine, docs, infra). Do not put her after IMPL (that would be screenshot QA later, out of scope).

## UX contract timing (Jason 2026-08-27 lock)

**The UX spec is updated at plan time, not in IMPL.**

- **New UX** (`assignee: mona` write): Mona writes/patches `UX_SPEC` **before PLAN**. Builders plan against that file.
- **`needs_ux` code ticket:** PLAN must draft or patch the UX spec (screens, thumb, states, AC). Mona reviews **that artifact**. Stamp. IMPL executes the spec and **must not invent HUD/UX**.
- If IMPL discovers the spec is wrong: **revise** (plan-only + Mona again), not a silent UI rewrite in the code session.
- WR-037 reviews a **plan-time UX contract**, not a post-ship screenshot.

## Goals

1. **Gated stage `UX_REVIEW` (or specialist review with agent `mona`)** after Crawmak verdict approve/approve-with-conditions, **before** plan stamp / IMPL.
2. **Run only when** ticket frontmatter says so, e.g. `needs_ux: true` or `ux_review: required` (pick one, document it). Missing bit = skip, same as `plan_review: skip` for Crawmak.
3. **Launch path:** named OpenClaw specialist `mona`, workspace `/run/media/j/M2MegaStore/Code/Ai/mona`. Not Grok-as-Mona. Not product-repo cwd unless the brief points at the UX spec path.
4. **Artifact:** `mona/reviews/<TICKET>-ux.md` (or workspace `reviews/`) with a required **Verdict:** `approve` / `approve-with-conditions` / `revise`.
5. **`revise`:** plan-only update once, then Crawmak + Mona again (or Mona only if the plan change is UX-only — say which in the plan; fail-closed if architecture moved). Cap one UX revise unless the ticket says otherwise.
6. **No stamp, no IMPL** while `needs_ux` tickets lack an approve-class Mona verdict.
7. UX **write** tickets (`assignee: mona` design phase) stay a **specialist stage before PLAN**, like Kawazaki — this ticket is the **review** slot, not the write slot. If write-before-PLAN is not already possible via specialist kick, note the gap; do not block this ticket on it.
8. `npm test && npm run quality` green; land commit + push origin.

## Tests (named contracts)

- No `needs_ux`: PLAN → Crawmak → stamp → IMPL (WR-028 unchanged).
- `needs_ux: true`: after Crawmak approve, launch Mona; **no** IMPL; **no** stamp until Mona approve-class verdict.
- Mona `revise` → plan re-queued; not IMPL.
- Mona `approve` without plan stamp → still waiting; IMPL not admitted.
- Mona `approve` + existing Crawmak approve + `APPROVED by Astra` (or Jason) on plan → IMPL.
- Human hold still `WAITING_APPROVAL`; annotations are not holds.
- `needs_ux` PLAN missing a UX spec path/draft is not reviewable — fail-closed, no IMPL.
- IMPL brief for `needs_ux` tickets points at the stamped UX spec; inventing UI in IMPL is a contract fail.

## Non-goals

- Running Mona on every ticket
- Screenshot / visual QA after IMPL
- Discord / TTS for Mona
- Changing Crawmak skip-bit rules
- SAFETY / overnight / unrestricted drain
- Auto-drain of `needs_ux` boards

## Notes

Mona agent is already stood up: id `mona`, Grok46, exec full, image gen on, internal only.
