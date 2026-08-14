# Wave Runner tickets

Git-native board for this repo. **Waves freeze an explicit ticket list**; this folder is not a drain queue.

**Interop contract is `FrozenTicket`**, not this folder’s YAML. Markdown here is the starter adapter (Jekyll/Hugo/Obsidian-style convention). Other trackers should emit JSON (`--tickets-json`) or implement `TrackerAdapter` — do not send us your board. See **WR-003**.

Markdown aliases: `id|ticket|issue`, `title|name|summary`, `status|state`, `depends_on|blocked_by|depends`, `agent_eligible|eligible`. Missing `id` may use a `WR-001-slug.md` filename prefix; missing title may use the first H1 or that slug. **No id (frontmatter or filename) ⇒ not spendable.** `README.md` is documentation, not a ticket.

JSON ingest does not require this folder. Schema `1` `{ tickets: FrozenTicket[] }` or a bare array. `contentHash` / `order` are computed at freeze.

GitHub Issues / Linear stay future adapters, not v0 clients.
