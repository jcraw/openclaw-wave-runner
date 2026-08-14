---
id: WR-003
title: Ticket interop — FrozenTicket JSON + markdown aliases
status: done
priority: high
created: 2026-08-14
updated: 2026-08-14
source: jason
agent_eligible: true
eligibility: agent_eligible
depends_on: []
verify: npm test
labels: [adapter, docs, interop]
---

# WR-003 — Ticket interop (JSON contract + markdown starter)

## Problem
Wave Runner is an OSS control plane, not a board product. Other people already have Linear / GitHub / their own markdown. Our YAML frontmatter is a **convention**, not a standard. Aliases alone will not make foreign boards work.

Interop is **`FrozenTicket`**. Markdown is a starter adapter. Bring-your-own mapper is the expected path.

## Canonical DTO (do not grow)
```ts
{
  ticketId: string
  title: string
  dependsOn?: string[]
  sourcePath: string
  verifyCommand?: string
  planClass?: string
  provider?: string
  model?: string
}
```
`contentHash` / `order` are computed at freeze. Do not pull story points, labels, or studio fields into the runtime.

## Scope
In:
- First-class **JSON ticket source** (`--tickets-json <file>` or stdin) that parses schema `1` `{ tickets: FrozenTicket[] }` (array-only also OK)
- When JSON is provided, **do not** require `issues/*.md`
- Markdown adapter stays: field **aliases** + filename/H1 fallback
- README honesty: reusable piece = freeze/budget/leases/stages; board format is not the product
- `issues/README.md` matches
- Tests for JSON ingest, aliases, filename/H1, fail-closed eligibility
- Explicit `--tickets` still selects by id even if `agent_eligible` is missing

Out:
- GitHub / Linear / Jira API clients
- Auto-discovering arbitrary prose / random `# Title` docs as spendable work
- A mapping DSL or “universal markdown spec”
- Changing wave ledger / `FrozenManifest` schema beyond accepting the JSON adapter
- Merge, push, overnight, drain

## Acceptance
- [ ] `JsonTracker` (or equivalent) implements `TrackerAdapter`; CLI `--tickets-json` freezes from it
- [ ] JSON tickets need `ticketId` + `sourcePath`; missing title → `ticketId`; missing `dependsOn` → `[]`
- [ ] Markdown aliases: `id|ticket|issue`, `title|name|summary`, `status|state`, `depends_on|blocked_by|depends`, `agent_eligible|eligible`
- [ ] Missing `id` → filename `WR-001-slug.md` when `^[A-Z][A-Z0-9]*-\d+`
- [ ] Missing `title` → first markdown H1 or filename slug
- [ ] Missing/malformed `agent_eligible` still fail-closed for auto-admission; `--tickets` still works
- [ ] README documents: FrozenTicket contract, JSON ingest, markdown starter + aliases, “write a mapper / TrackerAdapter — do not send us your board”
- [ ] `npm test` green

## Owning paths
- `src/adapters/markdown-tracker.ts`
- `src/adapters/` new JSON tracker
- `src/runtime.ts` / CLI create+dry-run wiring
- `src/adapters/studio.ts` only if eligibility aliases needed
- `test/`
- `README.md`
- `issues/README.md`

## Agent notes
Keep `TrackerAdapter.snapshot()` as the extension point. JSON is the cheapest interop; markdown is onboarding. Do not parse spendable tickets without an id (JSON field, frontmatter, or filename).

## Resolution

## Resolution

**Done 2026-08-14** (Grok IMPL). JsonTracker + markdown aliases shipped. `npm test` 85 passed. Wave `WR-003-202608140856` COMPLETED.
