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
  page for all parents of a request.
- App tables (`tableType`) take `orderBy` over the indexed columns the app declares and `filter` over
  its filter columns.
- `graph.query` ordered pages carry the same `filter`, and `relation.through` for projections. `types`
  and `relation.targetTypes` take up to 500 names, as `relation.edgeTypes` does; the bounds are
  exported as `graphQueryLimits`.
- `startsWith` is an index range. A page over every node type reads from an index on its order column.

Cursors have one format: the order's name with the record's order value and ID, for the default
`ID_ASC` too. A cursor made before this change (an encoded ID) is refused as invalid; start the page
again.

Removed, with no alias: `aggregate { count }` (use `totalCount`), the `slugs` argument of collections
(use `filter: { slug: { in: [...] } }`), the per-column list arguments of app tables (use `filter`),
the `search` list and the name `searchConnection` (the connection is now `search`). Documents written
against the old shape must be rewritten; the apps' own documents, seeds and tests are.
