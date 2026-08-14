# Contributing

Thanks for helping make agent backlog execution safer.

## Principles

1. **Fail closed** on missing usage, missing spawn ports, and ambiguous settle.
2. **Frozen manifests** — never silently expand a running wave’s ticket set.
3. **No LLM-as-scheduler** paths for normal progress.
4. Tests first for controller / budget / lease / idempotency changes.

## Dev loop

```bash
npm install
npm run quality:fast   # typecheck + tests
npm run quality        # PR/CI: hygiene, arch, tokens, coverage, proof, pack, DoD
npm run quality:full   # release/nightly: + Stryker on pure core
```

See `docs/QUALITY-GATES.md`.

## PR checklist

- [ ] `npm run quality` green  
- [ ] Do not treat coverage % as done — behavior tests must name the invariant  
- [ ] Do not weaken tests to satisfy mutation/coverage  
- [ ] No host-absolute paths (`/home/...`)  
- [ ] No secrets, personal repos, or private board dumps  
- [ ] Safety gates not weakened without a clear docs + test story  
- [ ] New public API documented in README or `docs/`  

## Scope we will reject

- “Drain until empty” / overnight auto-arm defaults  
- Recurring LLM poll control loops  
- Features that treat a live issue board as transactional runtime truth without a freeze step  
