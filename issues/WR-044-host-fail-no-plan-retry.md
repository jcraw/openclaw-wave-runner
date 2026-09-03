---
id: WR-044
title: ACP host / plan-artifact fails are not PLAN retries
status: open
priority: high
created: 2026-09-02
updated: 2026-09-02
source: jason
depends_on: [WR-042]
related: [WR-010, WR-023]
verify: npm test
agent_eligible: true
eligibility: agent_eligible
needs_jason: false
phase: open
labels: [orchestration, acp, plan-gate]
---

# WR-044 — Host/gate fails are not PLAN retries

Extend `stageDeathNoRetry` to Grok `ACP_TURN_FAILED` / `Internal error` / `connection_close` on every stage. Add `wave-cli recheck-plan` so a PLAN.md that now contains the exact verify command can admit without a new PLAN session. Prefer `outputDir/PLAN.md` over truncated ACP summary (SL-004 race).

Product verify-red still rearms IMPL (WR-010).
