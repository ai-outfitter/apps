# Onto documents, review work and recovery

## Ownership and rollout

Onto owns graph persistence, assertions, source captures, document definitions,
immutable revisions, integrity seals and its managing agent. The public SDK owns
provider discovery, qualified references, authorization transport and workflow
primitives. Domain applications own definitions and interpretation of their records;
Governance may supply policy but is not required. Provider bindings are explicit
installation IDs; matching a contract is never permission to read it.

This implementation is staged in the public extraction. It is not a production
cutover. Planning's roadmap and Governance's business review still use their
existing implementations in the platform; migrating them requires behavior and
seal parity tests. The bundled Wiki implementation must stay until a public Onto
release updates an existing installation and dependent applications are verified.
The platform-side migration-baseline protocol must deploy first.

## Definitions and authorized actions

Discover the independently versioned `outfitter.onto.documents` v1 contract
and explicitly bind its installation (`resolveOntoDocuments` and
`ontoDocumentsClient` in the public client). Compatible graph discovery alone
does not establish document support.

Use `document.define` as an owner/admin to register a definition ID and immutable
version, then `document.create` to bind an instance to it. Subsequent definition
versions do not silently change instances or authored graph definitions.
Use an installed provider's `graph.describe` contract and approved named or
bounded GraphQL read to configure each source. Definition inputs cannot supply an
owner, host, captured evidence, policy result or workflow identity.

A contract records its stable identity, input/output JSON schema, parameters,
optional half-open reporting period, refresh mode, rendering mode and integrity
requirements. Schema validation deliberately supports a documented subset:
`type`, `properties`, `required`, `items`, `additionalProperties: false`, and
`enum`; unsupported keywords fail rather than pretending validation succeeded.
`measures` currently records definition labels; it does not calculate metrics.

Deterministic sections specify a provider and JSON Pointer into that provider's
captured result. Each section has a title and required flag. Missing or ambiguous
selections are displayed as missing context. Domain apps should supply these
selections; template names alone do not implement roadmap or business semantics.
Agent or combined rendering runs in the registered `document-generation` workflow,
not in a page load or notification request.

`document.live` reads current authorized sources without storing revisions or
running inference. `document.generate` queues a durable job and requests an
interactive task. A dispatch failure leaves a queued receipt, not a completed
report. Query `document.job`; `document.retry` is owner/admin recovery for a failed
current job. Retrying or generating never makes a superseded revision current.
The same operations are exposed as named GraphQL documents and agent tools,
using the same action handlers and permission gates.

## Scheduling and batch review

An authorized member explicitly enables Onto's registered schedules using the
`onto.schedule` and `onto.documents-schedule` actions. The first persists the
daily ontology audit and six-hourly submitted-batch review schedules. The second
persists the daily document-generation schedule. The platform rechecks delegated
membership and permitted workflow authority. An audit run cannot impersonate a
batch-review or document-generation workflow.

A document schedule processes at most one queued job per occurrence. When the
queue is empty it selects one `refresh: schedule` document, queues a refresh and
processes it. A stable run receipt prevents a replay from processing a second job.
This is a bounded shared daily schedule, not independent configurable periods per
document; add separate scheduling semantics before promising exact refresh times
for many documents. Failed current jobs require explicit retry after the attempt
limit. Expired leases allow retry; results from expired workers cannot commit.

Batch submission persists review work in the same transaction as the submitted
transition. Drafts do not trigger review. Interactive wakeups are best effort; the
separate registered batch-review schedule recovers queued work. Findings are
advisory, bound to content digest/revision and fenced against late results.
Existing configured batch policy and commit authority still decide application.

## Captures, completeness and policy

Revisions retain content, definition version, source bindings, queries, parameters,
period, observations, generator/workflow provenance and completeness. Sources are
observed independently; there is no atomic cross-provider snapshot. Missing
pagination/completeness proof prevents a capture being called complete.
Owner-retained historical captures remain readable within the installation;
revocation blocks new source reads and publication. It does not silently erase
history or imply a retrospective deletion policy.

`document.seal` checks the exact current revision, content digest and current
source read set. A seal preserves integrity; it is not approval or adoption.
The current generic source verification and local seal occur in separate transactions. They do not replace Governance’s existing atomic Wiki membership/read-set seal or exact Wiki gate subject. That source-local fencing and gate bridge must be preserved before migrating the domain flows.
A configured required policy must return `allow` bound to the owner, instance,
revision, digest, action and configured provider. `deny`, `require-review`, stale
receipts and unavailable providers block a protected transition. There is no
implicit Governance dependency. The current provider implementation must expose
`document.policy`; a real Governance adapter is still pending.

A sealed revision may queue an event for an explicitly bound `document.event`
consumer. Delivery is leased, bounded and retried with a stable event ID. Consumers
must atomically deduplicate that ID with their effects; transport is at least once.
Inspect `document_events` within the installation for attempts and terminal errors.
There is currently no owner UI for event replay; administrative recovery must
preserve the event ID and current authority.

## GitHub sources and export

The public `@ai-outfitter/connector-github` package owns GitHub API translation;
Onto only binds its read callback to the authorized host. Graph-provider registration
and scheduled connector access remain pending.

The `github-report` source uses an explicitly authorized GitHub connection,
repository, branch and `[start,end)` period. Merged pull requests use `merged_at`;
commits use the committer timestamp. Captures retain links, SHAs, observations and
pagination limits. Merged PRs and commits are activity, not proof of a release or
running deployment. Missing access or exhausted bounds are incomplete, not zero.

On the current platform the repository request transport is interactive only.
Manual document tasks can capture it; scheduled GitHub reads fail closed until a
narrow delegated connector operation is implemented. Do not grant generic
interactive authority to schedules to work around this restriction.

The feature/bug example renders captured use cases, stories, acceptance criteria
and missing context. Its issue destination is a stub; it does not publish issues
or require GitHub credentials.

Markdown/Obsidian export selects an exact revision. Destination connection,
repository, base branch and path are configured separately from source access.
Before any external write, export verifies current source disclosure authority,
completeness, required seal and configured policy. It renders the saved document
body with provenance/frontmatter; a caller cannot replace the saved report period.
Optional frontmatter is namespaced under `custom`, so it cannot replace document identity or provenance. Obsidian output can map explicit simple Markdown links to configured vault paths; inline code and fenced code stay unchanged. Complex Markdown links remain portable Markdown.
Publication creates a reviewable draft pull request on a deterministic branch and
retains the external receipt. This is one-way export, not synchronization.

A destination/base conflict requires review. An uncertain external write remains
blocked for reconciliation rather than blindly retrying a possibly completed
commit or PR. Inspect its durable publication receipt and the destination before
recovery. Real-provider source/export demonstrations and operator-facing recovery
UI remain rollout gates; fixture tests alone do not establish these outcomes.

## Remaining acceptance before the full PRD is complete

1. Migrate Planning roadmap and Governance business-review definitions and UI to
   these public operations, retaining the existing evidence/read-set, revision,
   schedule/history and seal/replay behavior as parity tests. Provide a real
   optional Governance policy provider and a configurable replacement.
2. Move remaining platform/domain consumers from Wiki-specific discovery to
   explicit compatible bindings. SDK compatibility aliases remain until then.
3. Publish the SDK, builder and Onto contract dependency closure. Deploy platform
   baseline/release processing, switch official/personal notification callers,
   verify receipts, hosted isolated builds and an existing installation upgrade.
   Only then remove bundled app code and its webapp CI/deployment paths.
4. Implement a narrowly delegated scheduled GitHub source read and demonstrate a
   real authorized report capture, including period/pagination semantics.
5. Demonstrate both export formats against an authorized real destination and
   document recovery of uncertain connector outcomes. No issue publication is
   part of this acceptance; feature/bug destinations remain stubbed.
6. Evaluate the managing agent against seeded/unseeded representative schemas,
   duplicate mappings, access boundaries and changed connectors. Unit fixtures
   currently prove mechanics, not the quality of those agent judgments.

The full target architecture remains the platform architecture document. These
remaining gates are not optional just because this staged source is buildable.
