---
id: WR-003
title: Accept common markdown ticket field aliases
status: open
priority: med
created: 2026-08-14
updated: 2026-08-14
source: jason
agent_eligible: true
eligibility: agent_eligible
depends_on: []
verify: npm test
labels: [adapter, docs]
---

# WR-003 — Markdown ticket aliases + fallbacks

## Problem
README documents a custom YAML-frontmatter ticket. That is a common static-site/Obsidian convention, **not** a standard. Other people will have GitHub-style issue files, `name:` instead of `title:`, `state:` instead of `status:`, or no frontmatter (filename + H1).

Wave Runner must not pretend one studio schema is universal. Keep a **canonical** schema; accept **aliases** and cheap fallbacks. GitHub Issues API stays a future adapter.

## Acceptance
- [ ] Parser accepts aliases: `id|ticket|issue`, `title|name|summary`, `status|state`, `depends_on|blocked_by|depends`, `agent_eligible|eligible`
- [ ] If `id` missing, derive from filename (`WR-001-slug.md` → `WR-001`) when it matches `^[A-Z][A-Z0-9]*-\d+`
- [ ] If `title` missing, use first markdown H1 or filename slug
- [ ] Missing/malformed `agent_eligible` still fail-closed for auto-admission (`eligibleForBoundedWave`); explicit CLI `--tickets` still selects by id
- [ ] README documents canonical fields vs aliases vs “not GitHub Issues”
- [ ] Tests cover alias + filename + H1 fallback; `npm test` green

## Owning paths
- `src/adapters/markdown-tracker.ts`
- `src/adapters/studio.ts` (only if eligibility aliases needed)
- `test/` (new or existing tracker tests)
- `README.md`
- `issues/README.md`

## Agent notes
Do not add a GitHub Issues API client. Do not parse arbitrary prose-only docs as spendable tickets without an id (filename or frontmatter).

## Resolution
