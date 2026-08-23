# WR-032 plan — Serial apply commit, apply-mode fence, orphan PID lease, empty inspect

**Ticket:** `issues/WR-032-rrt-halt-apply-commit-lease.md`
**Verify:** `npm test && npm run quality`
**Land:** commit + push origin
**Author:** `JCraw <4335668+jcraw@users.noreply.github.com>`

APPROVED by Jason

## Decisions

| # | Pick |
|---|---|
| D1 | After apply copies + `markIssueDone`, `git add` those paths on primary and `commitWithIdentity` `Land <id> apply closeout.` `ApplyResult.commitSha` is HEAD. Nothing staged → keep HEAD, still ok. |
| D2 | Apply mode: `implFenceFailure` does not flip worker-success to failed. Verify still runs. Missing lease in commit-land mode stays fail-closed. |
| D3 | `expireStaleLeases` also drops writer leases whose `pid` is set and `process.kill(pid, 0)` is `ESRCH`. `EPERM` is alive. Missing pid is not orphan. TTL path unchanged. |
| D4 | `wave-operator.sh` loop: empty inspect status sleeps and continues (no tick). COMPLETED/FAILED at inspect still exit without start. `AWAITING_PLAN_GATE` ticks (WR-028). |

## Tests

`test/wr-032-rrt-halt.test.ts`: apply commit moves HEAD; apply-mode missing lease still DONE after verify; dead-pid lease released; operator script has no empty-status tick and no `approve` on gate.

## Learn

- bite: none
- candidate: apply copy without commit → next freeze misses prior ticket; apply-mode stale_fence must not FAIL applied work
- promote: no
