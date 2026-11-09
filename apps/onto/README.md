# Onto

Onto is its own app, `outfitter/onto`, installed at `/o/<org>/onto/` or `/apps/onto/`. It installs next to the webapp's Wiki Map (`wiki-map`) rather than replacing it: an organization moves its old Wiki into Onto as a separate step (`scripts/import-old-wiki.ts`). The graph routes keep the `/api/apps/wiki-map/` prefix so the platform's graph transfer reaches both apps the same way.

From the repository root, run `npm ci`, `npm run check -w @ai-outfitter/app-onto`, `npm run test:unit -w @ai-outfitter/app-onto`, and `npm run test:integration -w @ai-outfitter/app-onto`. Build both app modes with `npm run build -w @ai-outfitter/app-onto`; outputs are written to `apps/onto/.outfitter/packages/`. Browser tests use `npm run test:e2e -w @ai-outfitter/app-onto` and require Playwright and Chromium.

Onto is released like the other official apps (`.release-please-apps.json`); the webapp pins each release in `catalog/external-apps/onto.json`.

# Wiki: projects and shared context

> Onto is a typed graph database for people and agents. See [the plan](docs/graph-database-plan.md) for its scope.

People and agents use the same typed records to find, document and connect work.
The home page lists Organizations. Overview (`/overview`) groups Projects, People,
Organizations and Technologies. Its Types section explains the graph building blocks and each default entity or connection.
Type administration is optional and lives in Settings. Entity links use the generic Astro route `/<plural-node-type>/<node-id>`, for example `/projects/<uuid>`, `/organizations/<uuid>` or `/metric-definitions/<uuid>`. The path without an ID lists that type’s instances. The sidebar links to Projects and Organizations. The route renders the shared entity page; dedicated type pages can be added later. Type guides use `/types/<type-id>`.

## Four storage concepts

- `graph_types`: named entity/connection definitions, documentation and scalar property schemas.
- `graph_nodes`: typed entities, Markdown documentation, canonical app reference.
- `graph_edges`: directed, typed connections with notes and properties.
- `graph_assets`: attachments; bytes live in the app's R2 storage.

All records have stable IDs; types, entities and connections have revisions,
authorship and timestamps. Names are not identities. Two same-named people remain
separate. Relator participation and derived views use the same nodes and edges
through the [version 2 contract](docs/relators-and-assertions.md). Edge types
may opt into [version 1 endpoint constraints](docs/ontology-contract.md). The
Wiki assistant's read-only `ontology.audit` tool checks current or proposed
constraints before activation. Writes validate the resulting graph; types without a contract keep
their legacy behavior. Writes also check permission, record existence, property
validity and current revision.

The schema is one migration, `migrations/0000_onto.sql`, followed by repeatable JSON initialization.

## Standard context for every installation

`seeds/types-v1.json` is the authored source for the default definitions. Its pages
explain entities, projects, people, organizations, technologies, agents, goals,
measurements, documents and connections. Each includes guidance for agents.
The same definitions are visible as readable pages and through `graph-type`.

`npm run seeds:check` validates JSON definitions, records and structured bodies
without generating SQL. The app initializer loads the standard JSON graph.
Setup is idempotent by stable ID: add missing records and leave existing records,
including edits, revisions, provenance and archived records, unchanged. If a record is physically removed, a later upload can add it again. Historical SQL seeds stay unchanged; new data is loaded by setup.
The demo uses the same JSON. The shared `seeds/entities-v1.json` file adds Outfitter and Unsupervised as Organization records with stable IDs. The public seed also declares Webapp, Deepwork, Software Foundry and Workshop, each designed by Outfitter. The demo renders these directly; local startup creates or verifies their canonical Planning records before adding the project pages and edges. Installation-specific references stay in gitignored `seeds/public.local.json`, never in the public seed. No real person is in the public seed.

Local development also checks `seeds/personal.local.json` at startup. This optional,
gitignored file uses the same `outfitter-graph-entities-v1` format as the committed
seed. Existing IDs are preserved. Personal data is read only by the app-owned
`scripts/dev-entry.ts`, gated by `OUTFITTER_LOCAL_DEV=1` (set by the normal root
`npm run dev` command); it is never imported into a built app, preview or E2E.
The personal file can include `projects` and `edges` as well as ordinary `nodes`. Project startup creates or verifies canonical Planning records through the host and saves their references in a separate gitignored `*.references.local.json` receipt; participation is an edge from a Person or Agent to a project or organization. E2E and previews use only committed JSON. New standard data is loaded from JSON setup.

For a local Node installation, set `OUTFITTER_LOCAL_WIKI_INSTALLATION_ID` and map
its dispatch script in `APP_SERVER_ENTRIES` to this app's `scripts/dev-entry.ts`.
The committed seed supplies Outfitter and Unsupervised; personal context is optional.


Organization pages show up to 10 unique goals, including goals pursued directly and goals from projects linked through `part_of` or `designed_by`. Each inherited goal links back to its source project. Archived records and connections are excluded.

Projects have a Repositories section and a Link repository action. A Repository entity represents a whole GitHub repository; a `source_in` edge carries an optional directory and ref for a project within a monorepo. Software Foundry and Workshop share `ai-outfitter/webapp` with different directories; EONMUN Website uses its whole repository.

## Useful workflows

- **Create/link project** can document an external project directly in Wiki, or create or select a canonical Planning project and
  its documentation in one flow. It uses the existing scoped workflow-host entity
  operations with `entities.read` and `entities.write`. If documentation saving
  fails after Planning succeeds, the form retries the saved reference.
- **Edit documentation** edits Markdown on the selected entity.
- **Add participant**, **Add dependency**, **Set business unit** and **Add goal**
  use the default definitions without requiring schema configuration.
- **Connections** is secondary to the entity page. It shows immediate connections;
  mobile uses the relationship list instead of the diagram.

The entity SDK publishes `graph-type`, `graph-node` and `graph-edge`. Agents use
the same records and revision checks. A Project node can stand alone for external work, with organization ownership
expressed through graph relationships. When linked to Planning, it references the canonical
Planning entity as `{installationId,type,id}`. The browser cannot forge that
reference: project linking goes through the platform host's verified entity API.
Context relationships grant no execution permissions.

## People

Person is a generic graph node type. Wiki does not import iMessage contacts or
manage address books. Apps and connectors can use the existing entity contract;
automatic source synchronization is deferred.

## Boundaries and next milestones

SemLang is a future adapter documented in [the design notes](docs/semlang.md),
with no compiler/runtime dependency or ontology engine in this app. Metric pages
explain intended measurements; actual observations and autonomous execution
remain future work. Apple Health and HealthKit are distinct, and a proposed Meze
dependency does not establish a working connector.

Next: stable-ID Markdown import with conflict previews; verified account/agent
bindings; an SDK output hook to remove per-record provenance reads. The latter
currently adds query overhead to large MCP lists.

Agents propose records through [change batches](../../../docs/plans/wiki-change-batches.md):
they run the Wiki's documents (`src/server/documents.ts`) with `graph_mutate`,
`StageChanges` (opening a batch, or adding to one), `RemoveStagedChanges` and
`SubmitBatch`, and inspect proposals, evidence, confidence, policy and decisions with `ChangeBatch`
(`graph_query`). Its optional `refs` selects individual proposals when a full
batch exceeds the response limit. The Changes sidebar uses that same document
to load canonical page context and offers it as its read-only `batch.inspect`
action; browser descriptions never replace stored batch contents. A
member commits or rejects each submitted batch on **Changes**; agents cannot.
Agent documents reach only batches a member reviews, never a policy batch.
Forerunner stages its discovery runs with the `batch.*` actions, and other apps
call `graph.apply`, `graph.read`, `graph.query`, `graph.graphql`,
`knowledge-graph.render` and `artifact.preview`; none of these is an MCP tool.
The personal and organization Wikis share this engine
([overview](../../../docs/architecture/knowledge-graph.md)).

## Verification

Run `check`, `test:unit`, `test:integration` and `test:e2e` for this workspace.
Browser tests run inside `devenv shell`. Tests use isolated D1/R2 and canonical
Planning records; they do not mutate the personal production account.

### Decision records

`DecisionRecord` documents an actual decision. Link it to its `DecisionType` with
`decision_type`, the Person/Agent with `made_by`, their scoped `RoleAssignment`
with `under_assignment`, and the organization/project with `scoped_to`.
`establishes` links a goal-setting decision to its goals; each goal retains its
`measured_by` definitions. The shared seed documents CEO authority for
**Set Organization Goals**. Named human decisions belong in private/local data.
These are editable context records, not immutable audit receipts or runtime authorization.

## Authenticated HTTP graph backups

Wiki export, preview and import use ordinary authenticated APIs, not MCP calls.
Use the current user's OAuth token and an explicit personal or organization
installation. See [wiki transfer endpoints and commands](../../../docs/wiki-transfers.md).

The package command (`npm run transfer --workspace @ai-outfitter/app-onto --`)
runs the HTTP client.
Commands are `export`, `preview` and `import`; previews and imports name a saved
plan with `--plan`. The earlier MCP-specific `upload`/`resolve` command and journal
format are not used by this client. Preserve existing files and journals: HTTP
backups have their own documented format and do not silently reinterpret them.

The seed reconciliation library in `scripts/transfer.ts` remains used by local
development imports and its tests. It does not open an MCP connection.

## Knowledge graphs

A `KnowledgeGraph` is an ordinary Wiki node. Its JSON body holds the selection
(`rootTypes`, `selection` with relationships, `maxDepth`, `maxNodes` and stop
rules, and `purpose`) plus the GraphQL `query`, `hash` and `variables` it
compiles to; every type change recompiles stored documents
([`knowledge-graph-document.ts`](src/lib/knowledge-graph-document.ts)). The older
form below, `properties.root_type` naming a node type and `properties.pattern`
holding the relationships and maximum hop count, is still read:

```json
{
  "relationships": [
    "packages_product",
    "uses",
    "addresses",
    { "type": "experiences", "direction": "incoming" }
  ],
  "max_depth": 4
}
```

Names resolve exactly against this Wiki's type registry (not display titles);
UUIDs also work. Strings default to outgoing traversal. Incoming traversal
starts at an edge's target, while the displayed arrow keeps its stored direction.
The offering lens uses incoming `experiences` to reach customer segments from
problems. Outgoing `uses` does not bring in unrelated products sharing a dependency.
Optional `from_type` and `to_type` guards restrict a relationship to exact node
registry names or UUIDs. Guards always describe the stored source and target,
including when traversing an incoming edge; they never reverse its arrow. A rule
whose relationship or endpoint type is archived is skipped; other rules remain
active. Unknown or ambiguous types still fail closed, and an archived root type
cannot be selected. Older strings and unguarded objects retain their traversal behavior. Breadth-first traversal counts hops from the
anchor, handles cycles, and stops at `max_depth` (an integer from 1 to 10).
Nodes at the depth limit are included but not expanded, so relationships between
two boundary nodes are shown only if another permitted hop reaches them.
Only existing, unarchived records are displayed. Unknown or ambiguous type names
produce an error rather than silently broadening the graph.

The shared **Organization overview** definition (`004ef4f0-236f-47ba-830f-82b5780941de`,
slug `organization-overview`) has `root_type: Organization`, so every Organization
can select it without per-company attachments or identities. It follows explicit
Project → `part_of` → Organization and Offering → `offered_by` → Organization
links, products, customer segments/problems, goals and measurement definitions.
Endpoint guards exclude unrelated companies reached through shared products or
customer problems. A scoped segment's other recorded problems remain relevant
customer context. Product → `developed_by` is provenance, not proof of
ownership/delivery, and CustomerSegment → `customer_of` may still be proposed.
The view uses at most five hops and the existing 200-node bound; truncation remains
explicit. Linked metric Documents are evidence context, not automatically parsed
observations. No standard observation type, current metric value, freshness
calculation, authorization or execution is supplied by this lens.

Organization's optional `organization_id` string records its exact platform
organization identity within the current owner scope. A unique exact match can
select a default; missing/ambiguous bindings require an explicit choice. Display
names are never identities. Existing installations require an editor's explicit
revision update to add the declared property and set the node; add-only standard
setup does not replace existing or archived records. Local development can derive
this field solely from its explicit `localOrganizations` source-ID mapping,
without editing private files or changing saved revisions. Conflicting saved
bindings and archived Organizations remain untouched. After restoring an older
local snapshot, missing standard types and this shared overview are added without
adding fictional example entities or overwriting authored definitions.

Every entity has a Knowledge graphs view. Definitions matching its root type
are available automatically; `lens_for` attaches a definition to a particular
node, including one of a different type: attachment explicitly selects the new
starting node. Definitions are parsed and resolved once when selected; invalid
lenses show an error without breaking the other graph views. The definition page
uses that same validation. Definitions use the same graph-node API, authorization, revisions, export,
and documentation editor as other Wiki records. No extra database table or
permission is introduced. Traversals stop at 200 records.

`seeds/knowledge-graphs-v1.json` owns the initial types and offering lens.
The initializer loads new definitions from JSON. Existing historical migrations
and authored records are preserved; new standard data is not a SQL migration.

Graph rendering uses a generic layered layout with orthogonal edge routing.
Repeated predicates from one source share a visual junction; the grouping does
not create Wiki entities or change relationships. Node and edge-label bounds
participate in layout. The canvas fits both available dimensions and can expand
to the viewport; these rules apply equally to every knowledge graph pattern.

## Domain apps and the Wiki adapter

Apps own their domain definitions and setup workflows. They use the shared
`@ai-outfitter/app-sdk/wiki` adapter to add ordinary graph types, nodes and edges
to an explicitly selected Wiki. Wiki owns generic storage and entity access;
app-specific schemas and seed definitions stay in the app package.

Structured node bodies render as readable HTML sections using the node type’s
optional `jsonSchema`. Labels and field help come from that schema; the stored
body remains JSON. Ordinary Markdown notes keep their existing renderer.

## Home card and read-only projections

Operational Wikis publish two [home cards](../../../docs/home-cards.md)
(`home-cards.publish`). `changes-review` ("Today's Wiki changes") lists
[change batches](../../../docs/plans/wiki-change-batches.md#what-is-built)
waiting for review, with the time anything still waiting is approved, and
first discovery runs committed in the last day; each links to its page under
**Changes** (`/changes/<id>`). `recent-documents` lists the newest active Document
nodes (by `updatedAt`, then ID) with 3, 5 or 10 items for small, medium or large.
It is one bounded query against this installation's database, read as the
forwarded viewer, so an organization's and a person's Wiki stay separate. Items
show the title and the plain-text `summary`, never the Markdown body, and link to
the node's own page (`/documents/<id>`).

The read-only `organization-goals` entity type is a bounded projection, not a
stored record or a query language. `entities.get` with an active Organization
node ID returns up to 20 active Goal nodes reached by that organization's
outgoing `pursues` relationships, with their graph-node and graph-edge references,
revisions, titles and plain summaries, plus a `truncated` flag. Missing, archived
or non-Organization IDs are not found; `list` pages over active Organizations.
Domain apps such as Governance call it through the ordinary scoped entity host.
It records no progress and grants no access.
