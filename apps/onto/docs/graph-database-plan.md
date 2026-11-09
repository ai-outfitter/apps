# Onto as a graph database

Status: plan, for review. Nothing here is built yet.

Onto becomes a typed graph database for people and agents and nothing else.
Pages, agentic context, reports and generated documents move to a separate
Wiki app that reads Onto. This plan fixes Onto's scope, how agents name
records, how relationships are modelled and stored, what the database itself
enforces, and how today's data and code get there.

## Scope

### In Onto

1. **Types, nodes and edges.** Each node has exactly one type for life. Each
   edge type declares its endpoint types (see [Endpoint types](#endpoint-types)).
2. **Relators** for n-ary relationships (a RoleAssignment with holder, role,
   scope and approver; a Marriage with two spouses), and **projections**:
   read-only edges derived from relators.
3. **Both kinds of time.** *Validity* is when something was true in the world.
   *Revisions* are when Onto recorded it. Revisions are kept with their history.
4. **Change batches.** Proposals are staged, a person reviews them, and evidence
   and provenance are recorded on every write.
5. **Assertions**: claims about a node or an edge. They are never confirmed truth.
6. **Saved graph views and flattening.** A saved view is a named, typed
   selection. Onto can flatten a selection into Markdown that an agent reads
   (`knowledge-graph.select` / `knowledge-graph.render`). That stays in Onto.
   Running it on a schedule, keeping the output and showing it as pages does not.

### Not in Onto

| Excluded | Where it goes |
| --- | --- |
| Document generation, seals, source fences, scheduled reports, flattened pages | The Wiki app, reading Onto |
| Inference or reasoning beyond projections | Nowhere for now |
| Authorization derived from relationships ("Ada is CTO" grants nothing) | Platform and app access only |
| Other apps' canonical records (Planning projects) | The owning app. Onto keeps only a `source` reference |
| More than one type per node | Not supported |
| Edges on edges | Use a relator or an assertion instead |
| Merging identities across Wikis | The platform |
| Connector-private data on nodes (`privateData`) | Dropped |
| Search beyond title and text (embeddings, vectors) | Not now |

## Addresses agents use

UUIDs stay the storage key. Agents read and write **addresses**, which Onto
resolves on every write. Addresses are short, readable, and stable across
reads, so prompts cache well and mistakes come back as clear errors.

| Record | Address | Example |
| --- | --- | --- |
| Type | name | `Person` |
| Node | `Type:slug` | `Organization:sunny`, `Product:sunny` |
| Edge | `edge_type(From:slug → To:slug)` | `works_on(Person:ada → Project:sunny)` |
| Interval edge | the same, plus `@` and its start date | `reports_to(Person:ada → Person:bea)@2026-01-01` |
| Symmetric edge | ends in sorted order, with `↔` | `friends_with(Person:ada ↔ Person:bea)@2020-05-01` |
| Relator | its node address | `RoleAssignment:ada-cto-sunny` |
| Change batch | UUID | Agents copy it from the reply. Batches are short-lived and never cache. |
| Change item key | any short name | `add-ada` |

- Slugs are unique per type: `(typeId, slug)`. `Organization:sunny` and
  `Product:sunny` can both exist.
- The GraphQL `node` root takes the address: `node(id: "Organization:sunny")`.
  This is Relay's global object identifier, which encodes `Type:key`. The typed
  roots (`organization(slug:)`, `organizations(slugs:)`) stay as they are.
- Saved views take root addresses: `roots: ["Organization:sunny"]`.
- Results name edges as `{ type, from, to, validFrom? }` with node addresses
  and no edge id. Agents send that same shape back to update or archive an edge.
- An edge end is always written as `Type:slug`. 34 of the 40 seed edge types
  declared no endpoint types, so the type of an end cannot be inferred and is
  never left out.

## Relationship kinds and their keys

Every kind has one natural key. Onto refuses a second record with the same key
whose validity overlaps, the same way SQL:2011 does with
`PRIMARY KEY (…, period WITHOUT OVERLAPS)`. Today's `ontology-identity.ts`
already applies this rule and is kept.

| Kind | Example | Natural key |
| --- | --- | --- |
| Directed edge | `works_on` | (edge type, from, to) |
| Interval edge | `reports_to` | (edge type, from, to, valid from), non-overlapping |
| Symmetric edge | `friends_with` | (edge type, min(from, to), max(from, to)) [+ valid from] |
| Relator | RoleAssignment, Marriage | (relator type, its `uniqueBy` slot participants) [+ valid from] |
| Participation edge | `assigned_to` (relator → holder) | (edge type, relator, participant) |
| Projection | `spouse_of` from Marriage | derived: read-only, never written |
| Assertion | a claim about an edge | a node; its subject is an address |

Symmetric edges are stored once, with the smaller node id as `fromId`.

## Endpoint types

**Every edge type declares its endpoint types.** An edge that can genuinely
join anything (`mentions`, `related_to`) declares the supertype `Entity` on
that end, so it is generic on purpose.

- Validation, GraphQL and documentation no longer branch on whether endpoints
  exist. Every edge type gets typed GraphQL fields (`producesEdges`,
  `worksOnIncoming`), and every proposal can be checked against its endpoints.
- Agents can read which links are allowed. The proposal rules already ask them
  to "use the source and target types each relationship allows".
- Relator slots already declare participant types and keep doing so.
- One-time cost: declare endpoint types for the 34 seed edge types that have none.

## What the database enforces

D1 enforces foreign keys. With endpoint types required, the schema can refuse
wrong-type edges whatever code writes them. This is the composite-key subtype
pattern:

```sql
CREATE TABLE graph_nodes (
  id TEXT PRIMARY KEY,
  typeId TEXT NOT NULL REFERENCES graph_types(id),
  slug TEXT NOT NULL,
  …,
  UNIQUE (typeId, slug),
  UNIQUE (id, typeId)                 -- target of the endpoint foreign keys
) STRICT;

-- Allowed node types per edge-type end. `Entity` expands to every node type,
-- maintained when a node type is added.
CREATE TABLE graph_edge_endpoints (
  edgeTypeId TEXT NOT NULL REFERENCES graph_types(id),
  side TEXT NOT NULL CHECK (side IN ('from','to')),
  nodeTypeId TEXT NOT NULL REFERENCES graph_types(id),
  PRIMARY KEY (edgeTypeId, side, nodeTypeId)
) STRICT;

CREATE TABLE graph_edges (
  id TEXT PRIMARY KEY,
  typeId TEXT NOT NULL REFERENCES graph_types(id),
  fromId TEXT NOT NULL, fromTypeId TEXT NOT NULL,
  toId TEXT NOT NULL,   toTypeId TEXT NOT NULL,
  fromSide TEXT NOT NULL DEFAULT 'from' CHECK (fromSide = 'from'),
  toSide TEXT NOT NULL DEFAULT 'to' CHECK (toSide = 'to'),
  validFrom TEXT, validTo TEXT,
  …,
  FOREIGN KEY (fromId, fromTypeId) REFERENCES graph_nodes(id, typeId),
  FOREIGN KEY (toId, toTypeId) REFERENCES graph_nodes(id, typeId),
  FOREIGN KEY (typeId, fromSide, fromTypeId) REFERENCES graph_edge_endpoints(edgeTypeId, side, nodeTypeId),
  FOREIGN KEY (typeId, toSide, toTypeId) REFERENCES graph_edge_endpoints(edgeTypeId, side, nodeTypeId)
) STRICT;
```

- `fromTypeId` and `toTypeId` copy each end's type. The copy is safe because a
  node's type never changes, and the first two foreign keys prove it is correct.
- `fromSide` and `toSide` are constant columns, so a foreign key can name the
  side.
- `validFrom` and `validTo` replace the JSON `validity` column on edges, so the
  natural key and the indexes can use them. Nodes do the same.
- Kept in validation, not in the schema: no overlapping validity, symmetric
  ordering (it depends on the type's contract), relator slot cardinality, and
  property and body schemas.
- No foreign keys on slugs. Slugs are addresses that can be renamed, and
  renaming a node never touches its edges.
- Nodes and edges are archived, never deleted, so foreign keys use the default
  `NO ACTION`.

## Indexes

An edge is a triple (from, type, to). Triple stores (Hexastore, RDF-3X) keep
triples in several orders so that every access pattern is a range scan. Onto
needs three orders:

| Index | Serves |
| --- | --- |
| `graph_nodes (typeId, slug)` unique | address lookup; listing a type in slug order |
| `graph_edges (fromId, typeId, toTypeId, toId, validFrom)` | outgoing edges of a type from a node, optionally to one type: traversals, saved views, typed GraphQL fields |
| `graph_edges (toId, typeId, fromTypeId, fromId, validFrom)` | the same, incoming |
| `graph_edges (typeId, fromId, toId, validFrom)` unique where not archived | edge identity: "does this link exist", edge address lookup |

These replace today's `graph_edges_from_idx`, `graph_edges_to_idx` and the
partial unique index that skipped interval edges. Resolving an edge address
takes two node lookups and one identity lookup, all exact.

## Migration

Fast, then deleted.

1. **Reset Onto's schema to one migration.** Replace `0000`–`0016`, the
   baseline protocol (`migration-baseline.json`, `migrations/baselines/`,
   `scripts/migration-baseline.ts` and its test) and the legacy wiki-map
   lineage with a single `0000_onto.sql` holding the schema above. There are no
   Onto installations to upgrade in place.
2. **One import script** reads each old Wiki's export (webapp Wiki Map:
   Unsupervised, Keystone, Mezi, Artera, Sunny and the personal Wikis) and
   writes it into a fresh Onto installation:
   - IDs are kept. Slugs are kept, and made unique per type, which they
     already are.
   - Edge endpoint type columns come from their nodes.
   - Edge types with no endpoints get endpoints from the pairs they actually
     join. If those pairs span too many types, the end becomes `Entity`.
   - JSON `validity` splits into `validFrom` and `validTo`. `privateData` and
     document tables are not carried over.
   - Edges the new constraints reject are listed, not guessed.
3. **Delete the old Wikis and the import script** once each organization's
   Onto has been checked.

No major release: Onto stays on 0.x versions.

## Cleanup in the same work

- Remove from Onto: `src/server/documents/`, `src/server/source-fences/`,
  `src/server/sources/`, `src/server/exports/`, `workflows/document-generation`,
  the document GraphQL fields and documents, `seal-timer`, and the docs
  `documents-and-recovery.md`, `source-fences.md` and
  `portable-archive-authority.md`. They return in the Wiki app only if it needs them.
- Remove `privateData` and every path that reads or writes it.
- Remove the change-batch slug from #48. Batches go back to UUIDs: delete
  migration `0016`, the `batch` inputs and the `slug` output.
- Change `record-handles.ts` to the address grammar above, and delete the
  `type:from:to` edge handle it replaces.
- Delete the GraphQL and validation branches for edge types without endpoints.
- Make AGENTS.md and the docs describe the result, not the history.

## Open questions

1. `externalProvider` / `externalId` on nodes link a member's identity to their
   Person node (`identity.ts`). Keep them in Onto, or move them to the platform
   with identity merging?
2. The Wiki app that takes over pages, documents and reports: is it a new app
   in this repository, or the rebuilt webapp Wiki?

## Build order

1. This plan.
2. Schema reset, foreign keys, indexes and the endpoints table, with the seed
   edge types given endpoints.
3. Addresses (`Type:slug`, edge addresses), `node(id:)`, root addresses, edge
   results without ids; batches back to UUIDs.
4. Removals (documents, fences, privateData) and the docs.
5. The import script, run per organization on copies, then the real import,
   then delete the script.
