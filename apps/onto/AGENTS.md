# Onto graph data

- Wiki stores node types, relationship types, nodes and directed edges. Keep storage domain-neutral; consuming apps own their domain meaning.
- Load standard types and records from validated JSON seeds through repeatable initialization. Add missing identities without overwriting authored records. Do not put seed data in SQL migrations.

- Versioned ontology declarations and assertion payloads live in `@ai-outfitter/onto/contracts`; enforce them through the shared ontology validator on every write path. Never derive enforceable rules from prose.
- Agent-facing documents name records by handle, never UUID: type name, node slug, edge `type:from:to`, saved views by root slugs (`$roots`). Change batches keep their UUID. Storage keeps UUIDs; `src/lib/record-handles.ts` resolves handles on every write. Do not add UUID inputs or outputs to published documents.
- Relators stay ordinary nodes with typed participation edges. Create complete relators atomically through `graph.apply`; derived relationships are read-only views over those source records.
- Confirmation receipts are server-authored evidence for the exact assertion and reviewed subject snapshot. Preserve their history; never accept a confirmation from editable assertion bodies or portable imports.
- An entity's knowledge-graphs page accepts `rel` (repeat; `name:incoming`), `depth` and `max` to draw a draft graph a member can save. Keep `server/agent-route.ts` routes in sync with page params.

- Onto is a graph database only ([plan](docs/graph-database-plan.md)). Documents, reports and pages belong to the Wiki app.
- The schema is `migrations/0000_onto.sql`, schema only. Until the first installation, change it in place rather than adding migrations. Initialization loads versioned JSON without overwriting authored records.
- Page loads and release notifications never run inference or app compilation. Use registered workflows, trusted schedule/task run identities, durable leases and idempotent receipts. A workflow schedule may only start its own workflow.
