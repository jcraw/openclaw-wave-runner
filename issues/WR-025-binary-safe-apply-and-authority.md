---
id: WR-025
title: Binary-safe apply and cross-wave writer/land authority
status: open
priority: crit
created: 2026-08-20
updated: 2026-08-20
source: jason
assignee: crawmak
builder: crawmak
worker: grok
preferred_model: grok
agent_eligible: true
eligibility: agent_eligible
needs_jason: false
phase: impl
labels: [p0, apply, binary, lease, land, closeout]
depends_on: [WR-022, WR-024]
related: [WR-011, WR-013, WR-017, WR-021]
verify: npm test && npm run quality
verify_command: npm test && npm run quality
worker_out_dir: tmp/workers/WR-025
land: commit
---

# WR-025 — byte-identical apply; host-local writer/land mutex

Jam closeout (`WAVE_LAND_MODE=apply`) must copy **bytes**, not UTF-8 strings. Sprites and audio survive. Two waves on one primary repo share writer-scope and land/apply locks even when each lane has its own `wave.sqlite`.

## Goals

1. Apply I/O is `Buffer`. Binary paths never `git merge-file`. Same-file binary divergence leaves ours, `APPLY_CONFLICT`.
2. Per-wave sqlite stays the ledger. Repo authority locks live under `.git/wave-runner/locks/` (`git-common-dir`).
3. Writer: non-blocking skip when another ticket holds the scope. Land/apply: wait, never `land lock held` for a live holder.
4. `npm test && npm run quality`. Land commit (not apply onto a dirty WR tree).
