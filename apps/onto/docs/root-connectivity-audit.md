# Finding graph components outside the owner root

## Verified interfaces (2026-11-17)

The live Outfitter MCP advertises `onto/Entities` for personal scope, with types,
fields, filters, identifiers/revisions and cursor pagination (limit up to 100).
A read-only `Entities` request for `graph-edge`, including fromId, toId, typeId and
archived, returned those endpoints and a next cursor. Its schema includes nodeId
and nodeIds (up to 100) filters, so frontier adjacency can be read in batches.
`graph-node` and `graph-type` are the corresponding local entity definitions.
No graph content was mutated. Subsequent complete, repeated inventories covered
six installations; other scopes remained incomplete due to routing failures or
the scan budget. Repeated reads are not an atomic snapshot.

Follow-up discovery exposed `Ontology`, whose `root` is the server-resolved node
address. It confirmed existing roots for Artera, Sunny, Keystone and Outfitter,
and null roots for personal, EONMUN, Unsupervised and the workshop preview. Two
other accessible scopes still failed document discovery. No published identity
linking or initialization mutation was available during the live repair check.
The local `OwnerRoot` / `EnsureOwnerRoot` additions are not live until released;
their existence in this checkout is not evidence of a production repair.

Discovery searches for `disconnected` and `Debezium` returned no documents in
personal scope. Listing the Onto documents found Entities, saved explorations,
bounded named knowledge graphs and batch records, but no owner-connectivity report.
The MCP query tool runs discovered documents; its optional ad-hoc selection is for
Viewer, not arbitrary app GraphQL. Do not claim a new reachability operation already
exists just because the underlying GraphQL engine could support it.

The local native GraphQL schema supports paginated node collections/search and
`node.edges(direction: both)` with endpoint IDs. `graph.query` and saved knowledge
graph expansion already traverse multiple hops. They have depth/node/response
bounds and filtering; absence from one bounded result does NOT prove disconnected.
Relevant implementation: `packages/app-sdk/src/graph-graphql-schema.ts`,
`graph-graphql-selection.ts`, `knowledge-graph.ts`, and Onto `server/graph-query.ts`.

## Exact one-time inventory

1. Resolve the canonical owner root from trusted installation scope. Reuse
   `rootContext` semantics: exact organization_id, or the personal owner's canonical
   account_of link (or its verified account fallback after bootstrap support is
   released). Missing/ambiguous roots are setup findings, not thousands of
   disconnected-node findings. Never choose a root by title. Use the discovered
   server-resolved root address; personal account keys remain internal. A compact
   OwnerConnectivity report can combine that resolution with exhaustive traversal,
   rather than have clients guess identities or transfer the entire graph.
2. Read all authorized nodes and edges in ONE explicit installation scope, following
   every cursor. Keep only the relevant active endpoints and edges. Use the same
   structural rule as batch connectivity (unarchived nodes/edges, either direction).
   Temporal validity is a separate policy: native traversal can exclude retired
   relationships, while the current batch walk uses archive status. Choose explicitly
   rather than comparing results with different rules.
3. Build adjacency and walk from the root to exhaustion. Active nodes minus the
   reached set are disconnected. Run the same walk over each remaining component to
   group results. Complexity is O(V+E); a disconnected pair with an edge between them
   must be reported even though neither node has zero degree.
4. Return root, scope, scan completeness, component sizes, node addresses and source
   evidence references. Annotate standard seed/system records from trusted provenance
   where available; disconnected inventory is not automatically an error or a demand
   to attach every schema/configuration record to a person. Do not turn a missing or inaccessible shared endpoint into a
   claim about another tenant. Keep shares and installations separate.

A client can perform this with existing paginated Entities calls once it has a
verified root. A server-side read-only report is more efficient for large graphs:
reuse the existing graph load/traversal, return compact component summaries and
paginated details, and avoid copying every edge through MCP. This needs a small
published document, not a new graph service or inference model.

Pagination is not an atomic database snapshot. Writes between pages can produce a
mixed graph or missed IDs. Mark such an inventory provisional unless a consistent
snapshot/version check proves it complete. Prefer a transactionally consistent
server read or a guarded snapshot/retry. Bounded/truncated responses must explicitly
report incomplete, never classify the omitted remainder as disconnected.

## Repair/backfill

An inventory is not permission to manufacture links. Distinguish an absent owner
binding, a missing reference to an existing source, a genuinely missing relationship,
and intentional reference/legacy material. An agent may investigate each component,
propose only evidence-supported context edges in a normal review batch, and leave
uncertain components unresolved. Link a real research artifact or user problem to
its subject where supported; never label a vendor a partner merely to satisfy a
path. Re-run the deterministic report after approved changes. Do not bulk change
anchors, approve held batches, or rewrite provenance.

## Ongoing detection

The existing ontology-audit workflow has a scheduled execution path. Adding the
same deterministic component report there is the smallest ongoing solution; current
model review and node.isolated findings do not establish exhaustive root reachability.
No new schedule was created or modified during this investigation.

For low-latency monitoring, enqueue scoped dirty-component work after authoritative
graph/identity writes, coalesce by installation, and recompute after changes commit.
Edge additions can merge components; deletions, archival, reparenting, owner-binding
or identity-link changes can split or invalidate them. A simple append-only union
index is insufficient for those cases. Retain periodic complete reconciliation.

Graph revision receipts alone are not a complete change feed: graph.apply records
history, but identity-link and other direct paths do not all write graph_revisions.
Per-record revisions are not a global CDC offset. Cover every mutation path or use
consistent periodic scans; handle event replay, gaps, ordering and root changes.

No Debezium wiring was found in the checked apps/webapp source or configuration.
Debezium captures database row-change events; a consumer still must maintain graph
state and compute reachability. The current Onto adapter is D1/SQLite-oriented.
The official connector list does not list D1/SQLite, so do not assume a plug-in CDC
path exists here. A supported self-hosted database could use CDC if its deployment
actually provides it, but adding that infrastructure is unnecessary for the first
inventory and scheduled check. Platform-database CDC would not automatically cover
separate installation graph databases.

Source: https://debezium.io/documentation/reference/stable/connectors/index.html
(official source connector documentation, checked 2026-11-17).
