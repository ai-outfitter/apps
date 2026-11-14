# Planning

## Issue tools over MCP

Read `Issues` with `projectId` and optional `category`, `status` or `ids` filters.
Follow its pagination cursor and read identifiers/revisions before changing an
issue. `position` orders issues within a project's category.

Use `IssueChanges` with stable UUID item keys and the actions `createIssue`,
`updateIssue`, `deleteIssue` or `reorderIssues`. Mutations reuse the project
page's validation and authorization. Reordering requires every issue of the
selected category at its current revision. Retry the same key and identical
input after a lost response; read current records before starting a new request.
These operations save Planning work only and do not approve graph proposals,
submit delivery work or publish external issues.

Shared organization projects with goals, user stories, a draft press release and demo material. Members manage stones, pebbles and sand as one issue model, with independent sub-issues, assignment, due dates, completion and accessible ordering.

The package owns its routes, schemas, validation and installation-database migrations. It depends on generic Outfitter `api.serve`, `organization.members.read`, `threads.use` and `threads.provide` capabilities; app-side validation rejects assignments outside the current organization snapshot. Revisions prevent stale overwrites, and SQLite constraints reject cycles, cross-project parents and deletion of parents with children.

Operational installations start empty. The demo uses synthetic read-only records and requires Demos access. Forerunner boards remain private and independent. Ask Outfitter uses saved project documents and issues to answer questions and prepare private changes for review. Explicit approval applies the exact proposed fields; unsaved drafts require an opt-in. Conversations live in the platform's shared thread service (`@ai-outfitter/app-sdk/threads`); see [Conversations and proposals](#conversations-and-proposals). Chat requires an approved organization inference provider; manual planning works without one. Source integrations, GitHub publication, custom agents and resident prioritization remain deferred.

## Home card

Operational installs declare `home-cards.publish` and serve the reserved
`/api/internal/home-cards/v1/[operation]` route (platform dispatch only). The read-only `projects` card lists this
installation's projects in the Planning page's order (by name): 1, 3 or 6
at small, medium and large, plus project and open-issue totals at large. Each
project shows its open and completed issue counts from Planning's own records and
links to `/?project=<id>`, which the Planning page selects once it loads. Any
member who can open Planning can read the card; it never reads another
installation, Forerunner or personal records.

## Tests

Run `npm test --workspace @ai-outfitter/app-planning` for unit, integration and
desktop/mobile browser journeys (`test:unit`, `test:integration` and `test:e2e`
run each part). The hooks build Planning, Onto and Software Foundry from this
repository through `@ai-outfitter/app-test/prepare`, so no signed-in platform or
provider credentials are required.

## Ownership and architecture

Catalog presentation and `catalog/cover.png` belong to this package; the platform publishes generated images and compatible URLs. See [architecture and release boundaries](docs/architecture.md) and [Forerunner's deferred roadmap](../forerunner/docs/roadmap.md).

## Pasted meeting notes

Ask Outfitter works before a project exists and from saved project/issue pages. Paste notes to compare canonical project summaries, review an inferred target and approve a proposed issue or new project. Conversations are private by default; a member can explicitly share a new conversation with the organization when creating it. Proposals stay private to the member who requested them, and only approved fields become shared records. Ambiguous matches need a member choice. The optional GitHub repository field stores a validated repository URL; live GitHub reads and writes are a later slice.

## Wiki-backed use cases

Planning declares Wiki as an operational installation dependency. Installing
Planning creates the owner's Wiki if needed and automatically initializes the
`UseCase` definition. Existing Wiki content is preserved. Open **Use cases** and
see all use cases in the Wiki; no project filter, Wiki selection or setup step is needed. Choose a project when creating a use case. Existing
installations initialize missing definitions automatically when an editor opens
this page. Readers can view existing records without gaining write authority.

A use case stores actor, goal, trigger/preconditions, main flow, alternatives and
success criteria as a structured Wiki node body. Its `planning_installation_id`
and `project_id` properties associate it with the canonical Planning project by
ID. The association is metadata, not a copy of the project or a canonical-source
claim. Planning validates the project in its own installation before writing. The
use-case list includes every active UseCase node in the Wiki, including records
whose project is not available in this Planning installation. No personal notes are copied to Wiki. Archived records remain in Wiki,
and edits use Wiki revisions to reject stale saves. The editor preserves other
node properties and existing canonical references.

Wiki owns the records; Planning owns the type and editing experience. Other
clients, including MCP, can read the type schema and edit the same Wiki nodes.
The Planning chat assistant currently handles projects and issues only. Existing
project documents and user stories are not automatically converted to use cases.
Deleting a Planning project does not delete its Wiki use cases.

## Conversations and proposals

Planning publishes the `planning.conversation` thread type (contexts
`planning.project` and `planning.intake`) and answers the provider callbacks at
`/api/internal/threads/v1/<operation>`. The platform stores every message,
leases one reply per conversation and builds bounded model history from that
conversation only. Planning supplies canonical project context (re-read and
revision-checked from the page claim the browser sends as entry metadata
`planning.page`), typed proposal tools and explicit read tools:

- `list_child_conversations`, `read_conversation` (one child or the parent, bounded page) and
  `start_child_conversation` (several children may share one originating message);
- `list_workflow_history`, `read_workflow_history`: read-only run histories other installed
  apps publish (for example Software Foundry). They cannot start, retry or cancel a workflow.

A project can have several conversations. Children and workflow histories are
never injected into a reply; the assistant opens them only through these tools.

Proposals and decision receipts live in Planning's own `planning_proposals`
table (migration `0003`), keyed by installation, requesting member and a stable
request key (`thread:submission:toolCall`; an exact replay returns the same
proposal, other input with the same key is a conflict). `threadId` is a
reference, not a foreign key. Approval runs the proposal guard, revision
guards, domain write and receipt update in ONE batch; a stale revision rolls
everything back. After the commit Planning records the decision on the
conversation with `threads.append` under the source key
`planning.proposal:<id>:decision`; if that fails, the receipt is still
committed and the entry is retried on the next load or duplicate decision
without repeating the write. Approval also re-checks that the approver can
still read the conversation. Deleting a conversation (Planning's
`DELETE /api/apps/planning/agent/conversations/<id>` or any platform delete)
first calls Planning's acknowledged `deleted` callback, which cancels the
conversation's pending proposals; applied, rejected and uncertain receipts
remain. Deleting a project cancels its pending proposals.

Migration `0003` discards the former app-local transcripts
(`planning_agent_conversations`/`_turns`), keeps applied and rejected receipts,
maps executing/unconfirmed outcomes to `uncertain` and cancels never-executed
pending drafts. No timestamps are invented for migrated rows.

Tests build both Planning and Wiki and exercise real scoped entity calls in
isolated app workers. Browser coverage uses a synthetic Wiki API fixture for
create/edit/archive, desktop/mobile layouts and the read-only demo.

Planning uses the standard read-only PR preview. The isolated writable preview
host does not grant the cross-app entity access now required by its Wiki
dependency; full writable journeys run with installed dependencies locally.

## Discovery sidebar

**Opportunities** presents the Wiki's existing `Problem` records; **Customer
segments** presents `CustomerSegment` records. Both pages read the default
owner-scoped Wiki without copying its data into Planning. Each record and
collection links to its existing Wiki page, where editors can maintain it. The
sidebar **Wiki** link opens that same installation. Communities remain distinct
from customer segments. Demo examples are synthetic and read-only.

## Organization entry point prototype

Planning’s Product page server-renders offerings and linked project rows grouped by product. It does not assess readiness during initial loading. Its Operations page is reserved for future work. Agents read the same Wiki records (organizations, products, offerings, customer segments, problems, goals) and Planning's projects with `graph_query`.
The current organization comes from authenticated app scope; its canonical Wiki
`Organization` has the exact `properties.organization_id` binding. A unique match
is required, and missing or ambiguous bindings are reported as repair gaps.
Titles, role names and graph edges never grant access.

Wiki owns the reusable `organization-overview` KnowledgeGraph definition, available
on every Organization. Planning reads its saved pattern, canonical node/edge type
guards and depth. The 200-node lens cap is explicit; truncated views never claim
that omitted connections do not exist.

The Product homepage calls its SDK-backed reader directly during Astro rendering.
Read-only API clients may call `/api/apps/planning/product-graphs` for paged
product groups; the browser does not fetch it during initial loading.
Goal titles and metric definitions are context, not observations. Where the installed ontology has no supported dated
observation contract, latest values, progress and freshness remain explicitly
unknown. Current graph read time never establishes evidence freshness. Projects
outside the organization lens remain repairable gaps; the view does not silently
attach them or replace their identities. Readiness is advisory, scoped to the
selected project, and does not require a product, repository or execution target.

The local loader derives the binding only from its explicit `localOrganizations`
source-ID mapping. Saved snapshots stay unchanged; conflicting bindings and
archived nodes are preserved. Existing persistent local installations can receive
the missing view and binding through ordinary revision-checked Wiki entity writes,
without resetting the installation or changing source files.

## Initial rendering standard and remaining work

Product, Opportunities and Customer segments (including discovery detail pages) render their primary content in Astro from one page-level SDK-backed view model. There are no same-app HTTP content reads on those initial browser loads. Product reuses the same selection as the paged API, but reads its request-scoped Wiki and canonical Planning projects once for all groups. Wiki navigation is resolved from that read. Discovery detail graph controls progressively enhance the server-rendered related links from only the selected neighborhood. No server islands are needed for these primary records.

The Product and Discovery page readers use the standard `appDataContext(host).apps.database(...)` interface. Collection filters and projections run at their provider before pagination. The Product reader validates the saved organization lens, reads bounded incident neighborhoods and caches endpoint reads; it does not download the full Wiki. Related reads share one request-scoped context and discovery. Metadata on a resolved database supplies the canonical installation and hostname without a second discovery call.

The organization overview includes goals and a delivery timeline. KPI definitions reuse `Goal → measured_by → MetricDefinition`, reached through the current organization’s `pursues` relationships. Delivery updates are `Document` records linked with `documents → Organization`; the page accepts their structured `delivery-update` bodies and sorts by the recorded timestamp. Local Outfitter samples are stored only in the private Wiki seed, clearly marked staged. DAU target is X/TBD; inference-sales target is $100 over a seven-day window. Actuals remain disconnected until real analytics/billing evidence is available. Neither a commit nor a merged PR automatically marks a user feature shipped.

Remaining query bottleneck: the SDK supports scalar incident-node filters, so bounded graph traversal and Discovery lists still require multiple neighborhood requests. Endpoint caching and bounded parallel batches avoid duplicate and unlimited reads; a future batch `nodeIds` filter could reduce round trips without introducing another access framework.

Projects directory and individual project documents/issues now also use the standard collection facade and server-render their initial content. Detail reads use the canonical project ID and a project-filtered issue query; directory issue reads project only status and project identity for open counts. The server resolves grouping, parent labels and reorder bounds. The editing controller starts from an escaped JSON bootstrap instead of repeating the initial data request; member lookup is deferred until issue editing. Initial project readiness is explicitly unassessed, not inferred from absent graph data.

Follow-up work, deliberately unchanged in this pass:

- **Work execution:** graph-backed packages and execution are a separate workstream and are not added by this dashboard change.
- **Use cases:** server-render records and project choices, then bootstrap the existing authoring controller.
- **Settings:** review its interactive configuration reads separately. Operations is intentionally blank.

The project pages also need a server-side member-directory capability if assignee names are part of the initial HTML: the current organization-directory helper is browser HTTP. This is a concrete SDK prerequisite, not authorization to query the platform or another app's database directly.
## Graph-backed work packages

A project page shows canonical Wiki requirements and individual acceptance criteria,
with Wiki links for editing and supporting context. Link a Wiki `Project` to the
canonical Planning project reference, then use its authored `has_requirement` and `has_use_case` relationships, UseCase → UserStory `has_story`
links, and requirement `has_acceptance_criterion` relationships. General
ontology authoring remains in Wiki.

The project's work page reads this context (`/api/apps/planning/work-context`) and previews a package (`work.preview`). Preview
requires explicit `requirementIds` or an `issueId` whose Wiki `Issue` has
`targets_requirement` edges. Select an attached `ArtifactDefinition` if more than
one exists. The definition must have one `uses_view` link to a saved
`KnowledgeGraph` lens. That lens independently bounds the selected records.

Wiki's read-only `artifact.preview` renders the saved recipe and lens without
creating output records. Existing descriptive `sections` remain readable; optional
`sectionMappings` select exact type names and `links`, `summaries` or named `fields`
presentation. Existing authored type definitions are never overwritten by setup;
installations with an older ArtifactDefinition schema can continue using descriptive
sections, or explicitly upgrade their schema to permit mappings.

Preview returns rendered text, structured criteria, gaps, and a complete source
manifest. Its `workPackage` contains the versioned rendered package, criterion and
source revisions, template reference, and a SHA-256 digest of recursively key-sorted
JSON excluding the digest field. Preview is not approval, submission or acceptance.
No execution or immutable snapshot is created until an authorized submission.

Previews use the Wiki renderer’s exact source manifest and one bounded render call.
Project/issue and selected source revisions are checked for concurrent edits.
Responses above 500 KiB return 413 with a request to narrow context; this milestone
does not page oversized packages. Retired requirements and recipes are rejected.
Proposed requirements remain proposals even after a work package is approved.
Planned Wiki change batches can name a
work package as their source, so Wiki changes made for it carry that link.

Frozen briefs always identify sources by canonical entity references, independent
of local or hosted URLs. Planning’s UI retains clickable Wiki links. Provenance
selectors use the complete initial scoped Wiki graph and are compared with the
renderer’s same-snapshot rows, including active edges whose endpoint is archived.

## Execution and acceptance

The work page's route (`/api/apps/planning/work`) runs execution and acceptance:
`work.destinations`, `work.submissions`, `work.submit`, `work.get`,
`work.refresh`, `work.evaluate`, `work.request-review`, and `work.accept`.
Agents submit an intake's implementation work with the `IntakeWorkPreview` and
`SubmitIntakeWork` documents.
Submission freezes the inspected preview under a caller-bound request UUID and
routes through a configured Foundry project. Planning holds no forge credentials.

Criterion evaluations pin the frozen criterion revision, exact PR head, method,
and provider evidence identities/revisions. Passing requires successful verified
check or approval evidence; an image alone is insufficient. Requesting review
requires the current Governance Recommend duty and saves an evidence-bound draft.
Submission, required agreements, and a separate decision remain Governance actions.
Acceptance requires fresh sources, a verified merged PR, all criteria passed, and
the exact current control/package/evaluation/candidate decision.

`work.get` never writes. Readers see a dated saved observation when current
Foundry lookup requires additional authority or is unavailable. Protected writes
always fetch current evidence and fail closed. `work.refresh` explicitly records
an observation and reconciles a sourced Wiki Issue node, project link, and selected
requirement links. It preserves authored/archived conflicts and is retryable after
partial cross-app failure. Canonical `work-submission` entity reads use Planning's
own database and retain submitted content, evaluations, and recorded acceptance.

Combined readback above 500 KiB returns a saved summary and explicit
`readbackViews`. `work.get` views `snapshot`, `evidence`, `acceptance`, and
`evaluations` retrieve exact sections separately; evaluations can select an exact
`candidateCommit`. A section that exceeds the bound fails explicitly with 413.
No criteria, submitted content, or recorded acceptance evidence is truncated.

The package integration tests exercise the real four app Workers through scoped
dispatch with fixture forge/execution operations. They do not establish live
provider execution, production deployment, or a deployed product outcome.

## Work packages UI

Open **Prepare and inspect work** from a project’s context page to reach
**Work packages** (`/projects/<id>/work`).
Choose a planned issue, artifact definition, configured Foundry project, and
acceptance policy. Preview the exact scope and criteria, then explicitly approve
that package before submitting it to Foundry.

Submitted work shows its issue, PR commits, reviews, checks, images, criterion
evaluations, and acceptance blockers. **Refresh evidence** records a fresh
observation; a saved observation is identified separately from current lookup.
Evaluation controls bind each criterion to an exact candidate commit and provider
evidence. Merged, accepted, and deployed outcomes remain distinct.

Large readbacks show their saved summary and blockers first. Open **Submitted
scope**, **Current evidence**, **Acceptance record**, or **Recorded evaluations**
to retrieve the corresponding bounded section without truncating saved content.
The desktop/mobile browser journey covers preview, explicit approval, submission,
evaluation, review, acceptance, reload, and separate-section readback with fixture
responses; live provider verification remains a separate milestone.


## Project repositories

Use `patchProject` (also exposed by `MutateProject`'s edit action) with the current
project ID/revision and `mask.repositories`: a replacement list of
`{url, path?, ref?}` entries. Omission preserves the links; `[]` removes them.
Each GitHub repository appears once per project, with the optional directory and
branch, tag or commit stored on its `source_in` relationship. Repository nodes
are shared; unlinking archives only this project's relationships.

Planning publishes these app-owned changes immediately through the authorized
Wiki APIs. If needed, it creates a Wiki Project with a canonical reference to the
Planning project through the platform entity API. Conversational agent Wiki
proposals retain their separate member-review flow.

`repositoryChanges` returns `published` with the Wiki Project ID and graph receipt,
`unchanged`, or `failed` with an error and a retry input using the returned project
revision. Planning and Wiki use separate databases: the Planning save and an
already-created Wiki Project can persist after a publication failure. Retry with
the returned revision to reuse that Project and existing repository nodes. The
legacy `githubRepository` fallback is cleared only after successful publication;
that cleanup may advance the project revision again. Always use the revision
returned by the mutation. Existing readers continue to merge Wiki links with the
legacy fallback, and GitHub pull requests are fetched only when selected.
