# Onto graph data

- Wiki stores node types, relationship types, nodes and directed edges. Keep storage domain-neutral; consuming apps own their domain meaning.
- Load standard types and records from validated JSON seeds through repeatable initialization. Add missing identities without overwriting authored records. Do not put seed data in SQL migrations.

- Versioned ontology declarations and assertion payloads live in `@ai-outfitter/onto/contracts`; enforce them through the shared ontology validator on every write path. Never derive enforceable rules from prose.
- Relators stay ordinary nodes with typed participation edges. Create complete relators atomically through `graph.apply`; derived relationships are read-only views over those source records.
- Confirmation receipts are server-authored evidence for the exact assertion and reviewed subject snapshot. Preserve their history; never accept a confirmation from editable assertion bodies or portable imports.
- An entity's knowledge-graphs page accepts `rel` (repeat; `name:incoming`), `depth` and `max` to draw a draft graph a member can save. Keep `server/agent-route.ts` routes in sync with page params.

- Onto is the product and managing agent; retain legacy wiki-map app identity, routes and history until a verified existing-installation upgrade. Never reset private data implicitly.
- Keep new schema baselines seed-free. Preserve applied legacy migration files and use the explicit baseline protocol only for fresh databases. Initialization loads versioned JSON without overwriting authored records.
- Document definitions select authoritative domain sources. Captures and seals preserve exact revisions; seals are not business approval. Optional policy uses public revision-bound actions and must fail closed when required.
- Page loads and release notifications never run inference or app compilation. Use registered workflows, trusted schedule/task run identities, durable leases and idempotent receipts. A workflow schedule may only start its own workflow.
- See [documents and recovery](docs/documents-and-recovery.md) for staged limitations and cutover gates. Tests with synthetic providers are not evidence of deployed GitHub behavior or activation.
