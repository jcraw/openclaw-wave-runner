---
id: WR-016
title: Board dep truth — done tickets unstick dependents at freeze
status: done
priority: medium
created: 2026-08-15
updated: 2026-08-15
source: jason
agent_eligible: true
eligibility: agent_eligible
depends_on: [WR-013]
verify: npm test
labels: [board, deps, freeze]
---

# WR-016 — Board dep truth

## Problem
GS-058 create failed while GS-057 ticket file said done but BOARD/adapter still open. Dependents blocked falsely.

## Goal
At freeze/snapshot: treat ticket frontmatter `status: done` as satisfied dep even if BOARD.md stale; optionally rewrite BOARD on land (WR-013).

## Scope
1. MarkdownTracker: dep satisfaction reads ticket status first
2. On land-done, patch BOARD open→done lines when present
3. Tests for dep open-vs-done

## Acceptance
- [ ] Dependent admits when dep ticket file is done
- [ ] BOARD staleness alone does not block
- [ ] `npm test` green
