# Wave Runner tickets

Git-native board for this repo. **Waves freeze an explicit ticket list**; this folder is not a drain queue.

**Interop contract is `FrozenTicket`**, not this folder’s YAML. Markdown here is the starter adapter (Jekyll/Hugo/Obsidian-style convention). Other trackers should emit JSON (`--tickets-json`) or implement `TrackerAdapter` — do not send us your board. See **WR-003**.

Markdown aliases: `id|ticket|issue`, `title|name|summary`, `status|state`, `depends_on|blocked_by|depends`, `agent_eligible|eligible`. Missing `id` may use a `WR-001-slug.md` filename prefix; missing title may use the first H1 or that slug. **No id (frontmatter or filename) ⇒ not spendable.** `README.md` is documentation, not a ticket.

Plan-gate bits (YAML/JSON only; do not infer from labels or `assignee`):

- `plan_review: skip` (aliases `review: skip`, `review_skip: true`, `jason_skip: true`) skips Crawmak.
- `needs_ux: true` (alias `ux_review: required`, JSON `needsUx: true`) adds Mona `UX_REVIEW` after Crawmak approve-class. Optional `ux_spec` / `ux_spec_path` names the plan-time UX contract; else PLAN.md must contain `UX spec:` / `ux_spec:`. Optional `ux_review_revise_cap` (default 1).

JSON ingest does not require this folder. Schema `1` `{ tickets: FrozenTicket[] }` or a bare array. `contentHash` / `order` are computed at freeze.

GitHub Issues / Linear stay future adapters, not v0 clients.
