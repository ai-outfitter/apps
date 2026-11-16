# GraphQL conventions

We follow what the community already agreed on instead of our own shapes. This page says which
convention each part of our GraphQL follows, where we differ today, and what changes.

One rule sits above all of it: **filtering, sorting, paging and counting run in the database of the
app that owns the records.** The platform routes and merges. It never loads rows to filter or sort them.

## What the community uses

| Source | What it standardizes |
|---|---|
| [GraphQL Cursor Connections Specification](https://relay.dev/graphql/connections.htm) (Relay) | `XConnection { edges { cursor node } pageInfo }`, arguments `first`/`after` and `last`/`before`, `PageInfo { hasNextPage hasPreviousPage startCursor endCursor }`, opaque string cursors, a stable order from page to page. A server may support forward paging only. |
| [PostGraphile connections](https://postgraphile.org/postgraphile/5/connections) | The Relay shape plus `nodes` (the records without the edge wrapper) and `totalCount` (a `count(*)`, run only when asked). Every relation is a connection. `orderBy` is an enum of `FIELD_ASC`/`FIELD_DESC`. |
| [PostGraphile filtering](https://postgraphile.org/postgraphile/5/filtering) and [connection-filter](https://npmjs.com/package/postgraphile-plugin-connection-filter) | `filter: { field: { equalTo, in, greaterThan, includesInsensitive, … }, and, or, not }`, compiled to SQL. PostGraphile only filters indexed columns by default and warns against open-ended filters. |
| [Apollo Federation](https://www.apollographql.com/docs/graphos/reference/federation/subgraph-spec/) | Each service owns its types and its list fields. Other services refer to a record by key only. The router fetches referenced records in one batch per service (`_entities(representations)`), and the service loads them with one query ([N+1 guide](https://www.apollographql.com/docs/graphos/schema-design/guides/handling-n-plus-one)). |

GitHub, Shopify and GitLab all ship the same connection shape with `nodes` and `totalCount`.

## Where we stand

| Part | Convention | Today | Change |
|---|---|---|---|
| Connection type | `edges { cursor node }`, `nodes`, `pageInfo`, `totalCount` | `nodes`, `pageInfo`, `aggregate { count }` | Add `edges`. Rename `aggregate { count }` to `totalCount`. |
| `PageInfo` | four fields | `hasNextPage`, `endCursor` | Add `hasPreviousPage` and `startCursor`. |
| Paging arguments | `first`/`after`, optionally `last`/`before` | `first`/`after` | Keep forward paging; the spec allows it. `hasPreviousPage` is true when `after` was given. |
| Cursors | opaque strings | opaque, bound to the order they were made with | None. |
| Ordering | `orderBy` enum, `FIELD_DIRECTION` | `orderBy: ID_ASC …` on graph types; app tables are ID order only | Add `orderBy` to app tables (`tableType`) over their indexed columns. |
| Filtering | `filter` input with named operators | flat arguments (`ids`, `slugs`, `text`, one list argument per filter column) | Add `filter` with the connection-filter operator names over declared, indexed fields. `ids` stays as the batched known-ID read. `slugs` and the per-column list arguments go. |
| Relationships | every relation is a connection | typed relationship fields are connections; `Node.edges(types:)` is an unbounded list; projection fields page in memory | Make `edges(types:)` a connection. Page projections in SQL. |
| Old list fields | none | `search` (deprecated list) beside `searchConnection` | Delete `search`; rename `searchConnection` to `search`. |
| Federation | owner resolves lists; others hold keys; one batched fetch per service | The platform composes each app's schema under its own root field in one process. Lists go to the owning app through `graph.query` and `graph.graphql`; known IDs are read in one batch per app. | None to the model. See below. |

### Federation

Apollo's model has two halves: a contract each service implements (`_service { sdl }`, `_entities`,
`@key`), and a router process that plans queries across services. We already follow the model: the
owning app resolves its lists and pages, and cross-app references are keys read in one batch. We do
not run a router, and the platform Worker stays the single door.

Implementing the subgraph contract on each app's `graph.graphql` would let a standard router (Apollo
Router, Hive Gateway, Cosmo) compose our apps unchanged. It buys nothing until we want such a router
or an outside client that expects one, so it is not part of this change.

Merging one ordered connection across several Wikis is the one thing the platform does with rows:
each Wiki returns its own ordered page of `first + 1`, and the platform interleaves them by the same
order key. That is a merge of already-sorted pages, not a sort or a filter, and its cursor carries
each Wiki's position.

## Still filtered or sorted outside the database

These are the remaining places. Each one moves into SQL.

1. `Node.edges(types:)`: reads every touching edge. Becomes a connection.
2. Projection relationship fields: walked two hops, then paged in memory. Becomes one SQL statement per page.
3. App tables served with `tableType`: ID order only, so callers sort after reading. Gains `orderBy`.
4. Planning's portfolio entity list: keyset applied in memory over a computed list.
5. Platform `WorkflowRuns` search: filters run rows in JavaScript.
