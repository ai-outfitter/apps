# Wiki graph data

- Wiki stores node types, relationship types, nodes and directed edges. Keep storage domain-neutral; consuming apps own their domain meaning.
- Load standard types and records from validated JSON seeds through repeatable initialization. Add missing identities without overwriting authored records. Do not put seed data in SQL migrations.

- Versioned ontology declarations and assertion payloads live in `@ai-outfitter/app-sdk/wiki`; enforce them through the shared ontology validator on every write path. Never derive enforceable rules from prose.
- Relators stay ordinary nodes with typed participation edges. Create complete relators atomically through `graph.apply`; derived relationships are read-only views over those source records.
- Confirmation receipts are server-authored evidence for the exact assertion and reviewed subject snapshot. Preserve their history; never accept a confirmation from editable assertion bodies or portable imports.
- An entity's knowledge-graphs page accepts `rel` (repeat; `name:incoming`), `depth` and `max` to draw a draft graph a member can save. Keep `server/agent-route.ts` routes in sync with page params.
