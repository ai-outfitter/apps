# Onto as a graph database

Onto is a typed graph database for people and agents and nothing else. Pages,
reports and generated documents belong to a separate Wiki app that reads Onto.

## Scope

In Onto:

- **Types, nodes and edges.** A node has one type for life. Every edge type
  declares which node types each end allows.
- **Relators** for relationships with more than two parts (a RoleAssignment,
  a Marriage), and **projections**: read-only edges derived from relators.
- **Time.** *Validity* is when something was true. *Revisions* are when Onto
  recorded it, kept with their history.
- **Change batches.** Agents stage proposals, a person reviews them, and every
  write records its evidence.
- **Assertions**: claims about a node or an edge, never confirmed truth.
- **Saved views and flattening.** A saved view is a named selection that Onto
  can flatten into Markdown for an agent.

Not in Onto:

| Excluded | Where it goes |
| --- | --- |
| Document generation, seals, source fences, scheduled reports, pages | The Wiki app |
| Connector-private data on nodes (`privateData`) | Dropped |
| Inference beyond projections | Nowhere for now |
| Access derived from relationships ("Ada is CTO" grants nothing) | Platform and app access |
| More than one type per node, edges on edges | Use a relator or an assertion |
| Search beyond title and text | Not now |

## Addresses

UUIDs stay the storage key. Agents read and write addresses, which Onto
resolves on every write.

| Record | Address |
| --- | --- |
| Type | `Person` |
| Node | `Organization:sunny` |
| Edge | `works_on(Person:ada → Project:sunny)` |
| Edge with validity | `reports_to(Person:ada → Person:bea)@2026-01-01` |
| Change batch | its UUID, copied from the reply |
| Change item key | any short name, such as `add-ada` |

- Slugs are unique per type, so `Organization:sunny` and `Product:sunny` can
  both exist.
- GraphQL `node(id: "Organization:sunny")` takes a node address.
- Saved views take root addresses: `roots: ["Organization:sunny"]`.
- Results name an edge by its address, never by id.
- A symmetric edge (`friends_with`) is stored once with its ends sorted, and its
  address always uses the sorted order.

## Storage

```sql
CREATE TABLE graph_nodes (
  id TEXT PRIMARY KEY,
  typeId TEXT NOT NULL REFERENCES graph_types(id),
  slug TEXT NOT NULL,
  externalKey TEXT UNIQUE,
  …,
  UNIQUE (typeId, slug)
) STRICT;

CREATE TABLE graph_edges (
  id TEXT PRIMARY KEY,
  typeId TEXT NOT NULL REFERENCES graph_types(id),
  fromId TEXT NOT NULL REFERENCES graph_nodes(id),
  toId TEXT NOT NULL REFERENCES graph_nodes(id),
  validFrom TEXT, validTo TEXT,
  …
) STRICT;
CREATE INDEX graph_edges_out ON graph_edges (fromId, typeId, toId);
CREATE INDEX graph_edges_in ON graph_edges (toId, typeId, fromId);
CREATE UNIQUE INDEX graph_edges_identity
  ON graph_edges (typeId, fromId, toId, coalesce(validFrom, '')) WHERE archived = 0;
```

- **Endpoint types are enforced by the database.** Each edge type's contract
  lists the node types allowed at each end, or `"any"` for a generic edge such
  as `mentions`. A trigger on `graph_edges` refuses an edge whose ends have the
  wrong types, whatever code writes it.
- Foreign keys tie every edge to real nodes and types. Nothing is deleted, only
  archived.
- Edges store `validFrom` and `validTo` as columns so the identity index can use
  them. Overlapping validity, relator slot counts and property schemas stay in
  validation.

## Outside records

A node that stands for a record somewhere else carries that record's stable key
in `externalKey`, as `<host>/<table>:<id>`. Accounts are nodes of their own,
joined to the person or organization by `account_of`:

```
OutfitterUser:nicholas          --account_of-->  Person:nicholas
OutfitterOrganization:sunny     --account_of-->  Organization:sunny
```

| Record | `externalKey` |
| --- | --- |
| Outfitter user | `ai-outfitter.com/users:<uuid>` |
| Outfitter organization | `ai-outfitter.com/organizations:<uuid>` |
| Another app's record | `ai-outfitter.com/apps/<installation>/<type>:<id>` |
| GitHub user, later | `github.com/users:<numeric id>` |

A self-hosted Outfitter uses its own host. The slug is the readable name and can
change, while the key never does, so an import never creates a record twice.
Only the platform and imports set keys. This replaces `externalProvider`,
`externalId` and the JSON `source` column.

## Getting there

1. **Remove** documents, seals, source fences, GitHub sources and exports,
   `seal-timer`, the document-generation workflow, their docs, and
   `privateData`.
2. **Reset the schema** to one migration holding the storage above, and delete
   the old migrations and the baseline protocol. Give every seed edge type its
   endpoint types, add the account types, and put batches back on UUIDs.
3. **Addresses** replace today's handles everywhere agents read and write.
4. **Import.** One script copies an old Wiki's database into a fresh Onto,
   keeping ids and slugs and listing any edge the new rules refuse. Once each
   organization's Onto is checked, the old Wikis and the script are deleted.

Onto stays on 0.x versions.
