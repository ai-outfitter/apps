# Sharing part of a graph with another organization

A **share** says what this graph shows one other organization. It names three
things that already exist in Onto:

| Field | Example | What it decides |
| --- | --- | --- |
| `organization` | `Organization:sunny` | Who it is for |
| `graph` | `KnowledgeGraph:supply` | Which relationships, in which direction, which types stop the walk, how deep, how many nodes |
| `roots` | `{"Product:snsp-1": true}` | Where the walk starts |
| `hidden` | `{"Project:snsp-1-costing": true}` | Nodes left out, together with anything reached only through them |

The organization reads exactly what the saved KnowledgeGraph reaches from the
roots over current records, without the hidden nodes. A share holds a
selection, never a copy, so it can't drift. To share a whole graph, give the
organization read access to the installation instead. No share is needed.

```graphql
mutation { mutateShare(input: {slug: "sunny", expectedRevision: 0, patch: {
  title: "Sunny supply", organization: "Organization:sunny", graph: "KnowledgeGraph:supply",
  roots: {"Product:snsp-1": true}, hidden: {"Project:snsp-1-costing": true}
}}) { revision view { nodes { address } edges { address } } } }
```

- `MutateShare` (editors) creates or changes a share with a merge patch and the
  revision you read. `archived: true` stops it.
- `Share` lets any member preview exactly what the organization reads, as
  addresses. `Shares` lists them.
- The KnowledgeGraph, the Organization node and the roots must exist when the share is
  saved. A root can't be hidden.

## Examples

**Artera to Sunny.** Artera shares `KnowledgeGraph:supply` from
`Product:snsp-1` with Sunny. The KnowledgeGraph follows `produces` backwards and
`developed_by` forwards, two hops deep. Sunny sees the sensor, its firmware
project and Artera, but not Artera's other products or the hidden costing
project.

**Deep Work, Artera and Sunny.** Each owner shares from its own graph. The
Deepwork owner shares `Product:deepwork` with Artera and with Sunny as two
shares. Artera's share to Sunny never passes Deepwork records along, because a
share only walks the graph it lives in.

## Not yet

The platform doesn't route another organization's reads to a share yet. Webapp
draft #771 adds the piece needed: a caller from another organization arrives with
role `external` and `callerOrganizationId`, and only documents an app marks
`external` run. Once that lands:

1. Onto marks `Share` external. For an external caller, it serves only the
   share whose `organization` node carries that caller's
   `ai-outfitter.com/organizations:<uuid>` key (through `OutfitterOrganization`
   and `account_of`) and refuses every other document.
2. The platform adds `fromScope` to `graph_query` as well as `graph_mutate`.

## How other graphs shape access

| System | How access is shaped | What we took |
| --- | --- | --- |
| Neo4j fine-grained RBAC | `GRANT TRAVERSE / READ ON GRAPH g NODES Label`, `RELATIONSHIPS type`, property rules, `DENY` wins | Types and relationships pick what's visible; hidden wins over reach |
| Neo4j GDS projections, TigerGraph subgraphs | Name a projection of node labels and relationship types, and share it | The shared thing is a named selection |
| Datomic filtered databases, SQL views, Postgres RLS | A predicate applied to every read, so the client can't widen it | The selection is pinned on the server, and the caller can't send its own query |
| Google Drive, Notion, Solid (WAC/ACP) | Share a page or container and its children | Roots plus depth |
| RDF named graphs, SPARQL `CONSTRUCT` views | Publish a derived graph, often materialized | Not copied: every read walks current records |
| Apollo GraphQL contracts | Tags filter a schema into a narrower variant | Too coarse alone, since it works on types and not records |
| Dgraph predicate ACLs, ArangoDB collection permissions | Per predicate or collection | Same: types only |
| SpiceDB / Zanzibar (ReBAC) | Access derived from relationships in the graph | Rejected: in Onto, relationships grant nothing |
| ATProto, Wikidata | Everything public | No partial sharing to learn from |

Every system above shapes access by type (labels, predicates, collections), by
subtree (roots plus depth), or both. A KnowledgeGraph definition already holds
both, so a share needs one table and nothing else.
