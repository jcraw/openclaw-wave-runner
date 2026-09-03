---
id: WR-043
title: Enqueue resumes last good stage — do not re-PLAN
status: open
priority: high
created: 2026-09-02
updated: 2026-09-02
source: jason
depends_on: [WR-042]
related: [WR-044]
verify: npm test
agent_eligible: true
eligibility: agent_eligible
needs_jason: false
phase: open
labels: [orchestration, plan-reuse]
---

# WR-043 — Continue from last good stage

Re-enqueue of an approved ticket must not launch PLAN or REVIEW. Use forge `reviews/<ID>.md` Verdict approve / approve-with-conditions + existing PLAN.md → IMPL only. PLAN.md without approve → REVIEW only. Live duplicate → no-op.

See campaign plan `plans/2026-09-02-wr-042-live-run-enqueue.md`.
