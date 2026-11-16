# GraphQL conventions

We follow what the community already agreed on instead of our own shapes. This page says which
convention each part of our GraphQL follows and what we serve.

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

Every row below is built. Nothing replaced was kept: there is no alias, no deprecated field and no
second spelling.

| Part | Convention | What we serve |
|---|---|---|
| Connection type | `edges { cursor node }`, `nodes`, `pageInfo`, `totalCount` | Exactly that, on graph types, on app tables (`tableType`) and on hand-written app pages (`page()`, which takes the count, so none can leave `totalCount` out). `totalCount` is a `COUNT(*)` in the owning database, run only when selected. The edge wrapper of `XConnection` is `XConnectionEdge` (graph types named `…Edge` already exist, so the Relay name `XEdge` would collide). |
| `PageInfo` | four fields | `hasNextPage`, `hasPreviousPage`, `startCursor`, `endCursor`. |
| Paging arguments | `first`/`after`, optionally `last`/`before` | `first`/`after` only; the spec allows it. `hasPreviousPage` is true when `after` was given. A negative `first` is an error. |
| Cursors | opaque strings | Opaque, and one format everywhere (graph types, app tables, hand-written pages, `graph.query` ordered pages): the order's name with the record's order value and ID. A cursor continues only the order it was made with, the default `ID_ASC` included; anything else is refused as an invalid cursor. Every edge carries its own. |
| Ordering | `orderBy` enum, `FIELD_DIRECTION` | Graph types: `ID`, `TITLE`, `CREATED_AT`, `UPDATED_AT`. App tables: `ID_ASC`/`ID_DESC` plus the columns the app declares in `orders`, each backed by an index, keyset-paged in SQL. |
| Filtering | `filter` input with named operators | `filter: { field: { … }, and, or, not }` with the connection-filter operator names (`isNull`, `equalTo`, `notEqualTo`, `in`, `notIn`, `lessThan`, `lessThanOrEqualTo`, `greaterThan`, `greaterThanOrEqualTo`; on text also `includes`, `includesInsensitive`, `startsWith`, `startsWithInsensitive`). Graph nodes filter on `id`, `slug`, `title`, `createdAt`, `updatedAt`; edges on `id`, `title`, `createdAt`, `updatedAt`; app tables on the columns the app declares in `filters`. `ids` stays as the batched known-ID read and `text` as the search argument. `slugs` and the per-column list arguments are gone. `startsWith` compiles to a range (`column >= prefix AND column < next prefix`), so the index on the column seeks it; `startsWithInsensitive`, `includes` and `includesInsensitive` test the rows the other conditions and the page order leave (`instr`, literal: `%` and `_` mean themselves). |
| Filter bounds | only indexed columns; no open-ended filters | A filter holds at most 20 conditions, 6 levels and 200 values per `in` list. Each condition binds one parameter (a list binds as one JSON array), so a statement stays far below D1's 100 bound parameters. A larger filter is refused with a message that says so. |
| Relationships | every relation is a connection | Typed relationship fields, projection fields and `Node.edges(types:, direction:)` are all connections with `first`/`after`/`orderBy`/`filter`. Each is one page statement (and one count statement when `totalCount` is selected) for all parents of a request. |
| Search | one field | `search` is the connection. The old list is deleted. |
| Between services | `graph.query` ordered pages | Carry the same `filter`, and `relation.through` for projections, so a Wiki reached over a binding runs the same SQL as a local one. The ordered pages of one request are read together, each beside its count, and enter the response in request order. A page without `types` lists every node type with no type test, from the `(createdAt, id)`, `(updatedAt, id)` or `(title, id)` index (the primary key for ID order). Every bound of the request is a named constant in `graphQueryLimits` (`@ai-outfitter/app-sdk/graph-query`): 12 queries, 500 type names in `types`, `relation.edgeTypes` and `relation.targetTypes` (each list binds as one JSON parameter), 500 parents, 200 IDs, pages of at most 500. |
| Federation | owner resolves lists; others hold keys; one batched fetch per service | The platform composes each app's schema under its own root field in one process. Lists go to the owning app through `graph.query` and `graph.graphql`; known IDs are read in one batch per app. See below. |

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

What this change moved into SQL: `Node.edges`, projection relationship fields, app table ordering and
filtering, Planning's portfolio priority list, and the platform's `WorkflowRuns` search.

What remains, and why:

1. Slot fields (a relationship declared with a maximum, such as `owner`): at most that many records per parent, read with the request's edges in one batch. They are bounded lists, not connections.
2. `graph.query` queries without `orderBy`: text and property matching over the bounded snapshot read. An ordered page (`orderBy`) always runs in SQL.
3. Planning pages that are computed, not stored: single records assembled from several reads (served with `totalCount: 1`), and a project's `repositories`, which come from one bounded Wiki selection read plus the project's own repository setting and are keyed in memory. They have no table to page.
4. The merge of already-sorted pages from several Wikis, described above.
