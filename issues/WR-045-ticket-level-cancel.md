---
id: WR-045
title: Cancel one ticket without killing the live run
status: open
priority: high
created: 2026-09-02
updated: 2026-09-02
source: jason
depends_on: [WR-042]
verify: npm test
agent_eligible: true
eligibility: agent_eligible
needs_jason: false
phase: open
labels: [orchestration, cancel]
---

# WR-045 — Ticket-level cancel

`wave-cli cancel --ticket T` is sticky on that ticket only. Supervisor and other slices keep going. In-slice deps still block. Wave-level cancel remains for killing a slice. `emergency-stop` still kills every non-terminal slice.
