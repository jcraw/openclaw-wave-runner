# WR-037 plan — Mona UX_REVIEW after Crawmak, before IMPL admit

**Ticket:** `issues/WR-037-mona-ux-review-stage.md`
**Verify:** `npm test && npm run quality`
**Land:** commit + push origin
**Author:** `JCraw <4335668+jcraw@users.noreply.github.com>`

Depends on WR-028 (Crawmak `REVIEW`) and WR-033 (Crawmak approve-class **is** ledger-approve; leftover `APPROVED by Astra|Jason` is not required). This ticket does **not** reintroduce Astra/Jason stamps.

## Goal

When freeze-time `needs_ux` is set:

```
PLAN → Crawmak REVIEW → Mona UX_REVIEW → ledger APPROVED → IMPL
```

When `needs_ux` is missing/false, WR-028/033 stay unchanged.

Mona reviews a **plan-time UX contract**, not post-IMPL screenshots. IMPL executes that spec and must not invent HUD/UX.

## Decisions

- Canonical freeze bit `needs_ux: true` (alias `ux_review: required`, JSON `needsUx: true`). YAML/JSON only. Missing bit = skip Mona.
- `StageName += "UX_REVIEW"`. Ticket stays `PLAN_REVIEW`; wave stays `AWAITING_PLAN_GATE` until required reviews for this hop have approve-class verdicts.
- `queueStage("UX_REVIEW")` does not change ticket status and does not take a writer lease.
- `needs_ux`: Crawmak approve-class does **not** ledger-approve. Mona approve-class (`ux_review_admit`) does. Leftover Astra/Jason stamp cannot skip Mona.
- Launch: OpenClaw `sessions_spawn` `agentId: "mona"`, cwd = Mona workspace (`ctrl.monaRoot` else `MONA_ROOT` else the host Mona tree if `AGENTS.md` exists). Missing → `missing_mona`.
- Pass artifact `{monaRoot}/reviews/{TICKET}-ux.md` with Verdict only. Stage inspect still needs matching `terminal.json`.
- Grok-cli fallback refuses `UX_REVIEW`.
- UX spec: freeze-time `ux_spec` / `ux_spec_path` or PLAN.md `UX spec:` / `ux_spec:`. Missing → `missing_ux_spec`, stay `PLAN_REVIEW`.
- Mona `revise` → plan-only `REVISING`, event `ux_review_revise`, cap 1 unless `ux_review_revise_cap`. After UX revise, re-run Crawmak then Mona (revision-keyed).
- `plan_review: skip` still skips Crawmak only. Skip + `needs_ux` still requires Mona (no `plan_gate_auto`).
- Schema v5: `needs_ux`, `ux_spec_path`, `ux_review_revise_cap`.
- `UX_REVIEW` uses `WAVE_PLAN_WALL_MS`. `parseStageFromIdempotencyKey` must keep `UX_REVIEW`.
- Pre-PLAN UX write remains an operator specialist kick.

## Learn

- bite: none
- candidate: needs_ux freeze-bit → Mona UX_REVIEW after Crawmak approve-class, before IMPL admit; skip Mona when bit missing
- promote: no
