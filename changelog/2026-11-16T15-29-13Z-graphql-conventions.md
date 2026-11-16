# GraphQL follows the community's connection and filter conventions

Every list our GraphQL serves is now a Relay cursor connection in PostGraphile's shape:
`edges { cursor node }`, `nodes`, `pageInfo { hasNextPage hasPreviousPage startCursor endCursor }`
and `totalCount`. Lists take `orderBy` (an enum of `FIELD_ASC`/`FIELD_DESC`) and `filter`, with the
connection-filter operator names (`equalTo`, `in`, `greaterThan`, `includesInsensitive`, `and`, `or`,
`not` and the rest). See [GraphQL conventions](../docs/plans/graphql-conventions.md).

Filtering, sorting, paging and counting run in the database of the app that owns the records:

- A Wiki compiles a filter to SQL over its indexed fields (`id`, `slug`, `title`, `createdAt`,
  `updatedAt`). A filter holds at most 20 conditions and binds one parameter for each.
- `Node.edges(types:, direction:)` and projection fields are connections, read as one statement per
  page for all parents of a request. A relationship that selects `totalCount` is counted in that same
  statement.
- A `GraphSource` page (`nodePage`, `relationPage`) is `{ rows, hasNextPage, count? }`: at most `first`
  rows, whether more follow, and the count when the page asked for it and the source read it with the
  page. `relationPage` answers one page per parent.
- App tables (`tableType`) take `orderBy` over the indexed columns the app declares and `filter` over
  its filter columns.
- `graph.query` ordered pages carry the same `filter`, and `relation.through` for projections. `types`
  and `relation.targetTypes` take up to 500 names, as `relation.edgeTypes` does; the bounds are
  exported as `graphQueryLimits`.
- `startsWith` is an index range. A page over every node type reads from an index on its order column.

Cursors have one format: the order's name with the record's order value and ID, for the default
`ID_ASC` too, encoded as base64url of the JSON's UTF-8 bytes (at most 2048 characters). A cursor made
before this change (an encoded ID) is refused as invalid; start the page again.

A request reads at most 20,000 relationship rows (`graphQueryLimits.relationRows`). Parents are read
in runs of at most 20,000 / (`first` + 1), so no statement can read more rows than that, and a
request that has read more is refused (`RELATION_TOO_LARGE` in GraphQL, a 400 in `graph.query`); ask
for fewer parents, a smaller page or a narrower filter.

`search` on app tables matches a literal substring ignoring ASCII case, so `%` and `_` mean
themselves. Wiki nodes offer `title`, `createdAt` and `updatedAt` as entity list orders.

Removed, with no alias: `aggregate { count }` (use `totalCount`), the `slugs` argument of collections
(use `filter: { slug: { in: [...] } }`), the per-column list arguments of app tables (use `filter`),
the `search` list and the name `searchConnection` (the connection is now `search`). Documents written
against the old shape must be rewritten; the apps' own documents, seeds and tests are.
