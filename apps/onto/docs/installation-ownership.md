# Installation ownership and graph context

Onto's owner is the host-dispatched `AppIdentity.owner`, not a node in its graph.
For organizations, `organizationId` must match that owner. Personal ownership uses
the installation account rather than the actor initiating the request. Inconsistent
identity fails closed. Neither graph edits, source text, batch purpose, nor a
Governance home selection may select the tenant or widen permissions.

The reviewer receives this scope in both batch reviews and scheduled audits.
An optional graph representation is found only by an exact active Organization
`organization_id` binding. No title/slug matching is used. Missing or duplicate
bindings do not make the installation owner unknown; a duplicate remains a graph
quality problem. Home/charter selection is unchanged and remains separate.

Both organization and personal batches default to their existing canonical graph
root. Organizations use an exact active organization_id binding to the trusted
installation owner; personal installations use the owner's uniquely verified Person/Agent
holder, falling back to its canonical OutfitterUser account when no holder is linked.
New nodes must reach saved anchors directly or indirectly through honest semantic
or context links. An owned research document can connect an external organization
without asserting that it is a subsidiary, customer or partner. Explicit anchors
add a context constraint; every new node must independently reach the owner root.
An empty list selects the owner root. Previously saved anchors are never rewritten.
Even legacy null anchors cannot bypass the root at validation or approval.

Missing or ambiguous roots allow staging but block nonempty batch submission and
approval, including policy and steward commits. Standard initialization now creates
a missing canonical account/organization root from trusted installation scope. The
editor-only EnsureOwnerRoot operation repeats that safe setup for existing installs.
Conflicts, archives and authored schema constraints remain explicit editor work;
identity-link remains the supported path to associate a personal account with a holder.
Resolve duplicates deliberately. Do not invent relationships or bind a foreign org.
Once the root is established, revalidate the staged batch and attach truthful context
paths. Proposed changes are checked against the projected graph; removing/duplicating
the root cannot pass validation. Commit checks use a guarded graph snapshot.

Evidence validation, authorization,
confidence policy, review findings and content-digest checks remain in place.

## Upgrade and reconciliation

This is a read-time ownership correction retaining canonical-root defaults in both
scopes (restoring the organization default removed by the first draft of PR #221).
It needs no SQL data migration. Initialization adds only a missing canonical owner
representation, using host identity and generic labels; it never guesses a real name.
Existing canonical records are preserved. Conflicting setup is reported as blocked.
It does not rewrite existing graph records, Governance settings, stored anchors,
review receipts, approvals or actor permissions.

For pending batches, request a fresh review through the normal authorized workflow
after upgrade. Existing reviews remain historical evidence; do not edit their
findings directly or bulk approve held proposals. A saved implicit anchor from an
older version is indistinguishable from a deliberately chosen anchor. Preserve it:
a member should preserve intended anchors and add evidence-backed context paths
before requesting review. Change anchors only when intentionally selecting different
context; do not clear them simply to make the batch pass. Unrelated schema, evidence or scope issues can still hold
an interview or NVIDIA batch after the ownership error is resolved.

No live batch was changed by this patch. Rollout must verify both organization and
personal installations, then read the new review receipts before claiming the held
batches are resolved. Publication/preview and deployment remain separate actions.

## Regression coverage

Unit cases cover blank/unbound graphs, foreign/name-similar records, misleading
home settings, duplicates, archived bindings, personal owners versus actors, and
inconsistent identity. Integration coverage exercises an unbound installation's
external reference batch and confirms host scope reaches model input; existing
explicit-anchor and personal-anchor tests are retained. Model outputs in these
tests are synthetic. Passing them is not a live reviewer accuracy evaluation.

## Compatibility and remaining boundaries

This intentionally tightens batch acceptance: clients that sent empty anchors to
opt out, or relied on an uninitialized owner graph, must establish a root and link
new nodes. Saved anchors, committed history and reviews are retained. Explicit
anchors must be satisfied in addition to the root, not merely be present in the same
batch. Final commit checks also apply to historical pending batches.

This is a batch-ingestion rule, not a new universal graph-write permission policy.
Existing authorized direct graph/entity edits and identity linking remain available
for bootstrap and repair. They can still produce disconnected data. Schema-only
batches currently also require a root; empty batches have no graph writes. Existing
nodes are not retroactively repaired. Connectivity checks constrain created nodes;
updates that disconnect older nodes are not a whole-graph connectivity audit.
Batch commits retain the 100-operation limit but now pack dependency-complete,
root-connected groups, revisiting context edges that were staged after their nodes.
Every chunk validates its projected graph and commits with a graph/batch snapshot
guard. This allows large batches without temporarily publishing disconnected nodes.
The whole batch is not one transaction: earlier chunks remain committed if a later
chunk is refused or a concurrent edit changes the snapshot. Existing receipts and
operation states support retry; inspect them rather than assuming rollback. A group
that cannot be safely split within 100 operations is refused. This is a conservative
greedy packer, not a general ontology-aware transaction planner; complex atomic
relators or schema changes may need smaller explicitly complete steps.

Partial member approval must include the supporting context edges as well as the
chosen entities. We do not silently approve additional semantic claims to connect a
member's selected subset. Policy and steward selection hold unsupported subsets.

## Practical bootstrap before rollout

Inventory installation roots before upgrading automation-heavy installations. Use
the published `OwnerRoot` read and editor-only `EnsureOwnerRoot` mutation after
the supporting package is released. The mutation takes no identity inputs: the
host supplies installation ownership. New installs and upgrades run the same
setup automatically. Personal setup needs no invented Person: an unlinked canonical
OutfitterUser account is a usable root. Existing uniquely verified holders remain
the root. A later explicit account_of link connects the account to that holder.

For deliberate reconciliation of existing authored entities, use trusted installation
scope, never names, to identify the expected organization ID. An authorized editor
can bind the existing canonical
Organization by setting its declared organization_id property to that ID; if the
property is absent in an old type schema, the editor can add its optional string
property first. If no correct node exists, create it from verified owner information.
For a verified personal holder, select the correct Person or Agent and use the existing editor
identity-link endpoint for the installation owner's principal (not the actor).
Ambiguity requires deliberate reconciliation, not automatic deletion or guessing.

The new documents reuse existing editor permissions and installation authority;
they grant no platform capability. Direct graph writes remain available for setup
and repair. Staging and reading drafts remain available before setup. Once the canonical root is valid,
revalidate existing drafts, add evidence-backed context paths, and review normally.
Rollout does not auto-edit pending batches or claim their historical findings fixed.

### Local verification status (2026-11-17)

The earlier 14 failures were traced to uninitialized or disconnected fixtures.
They now explicitly model organization-owned contact research and its documents
relationships, retain the original approval, amendment and concurrency assertions,
and count the extra context operations. Creative records connect through their
existing subject; timer and question fixtures use the same explicit source context.
A 203-operation regression stages context edges last and verifies chunked commits.
Root-bypass regressions and host-owner unit coverage remain in place. Tests of
reviews use mocked model output; no live production review has been performed.

Existing graph.apply authority is entity-writer authority, not a newly introduced
editor-only bootstrap gate. Identity linking still requires an editor. No new
permission or capability is granted by these changes.

Previous local checks before automatic initialization: 70 integration tests passed together
across batches, root connectivity, reviewer/scheduling, questions, sealing, creative
workflows, identity, graph writes and initialization. All 124 Onto unit tests and
42 repository tooling tests passed. Astro check reported zero errors/warnings (two
existing hints); actionlint and git diff --check passed. Packages were rebuilt for
these integration runs. This is local evidence, not CI or production verification.

## Independent defect-first review and corrections

An independent read-only reviewer examined the full patch and re-reviewed the fixes.
The review identified two invariant gaps (including a concurrent variant) and an
existing bootstrap limitation that became important under mandatory root checks:

- Personal identity unlink/rebind archived account_of edges without incrementing
  their revision. The graph snapshot guard could therefore miss a root disappearing
  mid-approval. Identity archival now increments edge revision; a real unlink
  interleaved during approval is rejected by the commit guard.
- A later partial approval could remove the only path for a node created earlier
  in the same batch. Previously committed active creates now remain obligations
  during packing, validation and commit; replacement context must commit with the
  removal. Projected archive state also prevents create-archived/unarchive evasion.
- A concurrent approval could commit a new obligation after another reviewer loaded
  the rows but before that reviewer read a fresh graph. The final SQL guard now
  compares every originally loaded live batch operation, adjusting expected states
  only for this call's own earlier chunks. The regression deliberately reproduces
  that exact interleaving and verifies the second approval is refused.
- Explicit identity relinking previously reused an archived account while leaving
  it inactive. Authorized linking now restores that existing account with a revision
  increment and reconciles retained links without duplication. Tests cover valid
  unlink/archive/relink and a separately labeled historical inconsistent fixture.

The independent re-review found no additional actionable defect in these fixes.
It does not constitute production verification or deployment approval. Connectivity
obligations are batch-scoped: an unrelated direct edit or separate batch can still
change older graph context; use the proposed periodic inventory to detect that drift.
See [root-connectivity audit](root-connectivity-audit.md) for verified MCP/GraphQL
options, backfill safeguards and change-monitoring limitations.

## Automatic owner root initialization (local follow-up)

Installation initialization now invokes `ensureOwnerRoot` after standard types load.
The same narrow editor-only operation is published as `EnsureOwnerRoot` with no
identity inputs; `OwnerRoot` reads its status and graph address without writes.
Only trusted host installation owner metadata determines the account/organization.
The deployment actor may be a platform service and never becomes the owner.

For organization installations, preserve a unique active exact `organization_id`
binding. If none exists, create an Organization titled "Installation owner
organization" with the exact ID. This is a generic representation of the verified
owner, not an assertion of a guessed legal name. Do not adopt similarly named
nodes or merge existing unbound organizations. Reconciliation of such duplicates
remains explicit, evidence-supported editor work.

For personal installations, preserve a unique valid active `account_of` holder.
Otherwise a canonical OutfitterUser account with the owner's internal account key
is itself the fallback root. Bootstrap never fabricates a Person or Agent. Later
explicit identity linking makes the verified holder the root; the real account_of
edge preserves the old account root's connectivity and saved anchors. Unlinking
that edge leaves the account root in place, but saved holder anchors and historical
material may need explicit reconciliation. Bootstrap does not rewrite anchors,
commit pending batches or attach previously disconnected material.

Root insertion validates current ontology rules and commits behind the existing
whole-graph snapshot guard. A concurrent exact binding triggers a fresh read; the
winner is preserved. Repeated calls do not update roots. Archived exact bindings,
wrong-type account keys, ambiguous or invalid holder links, and custom schemas
requiring unknown values return blocked status rather than silently replacing or
inventing records. Expected schema conflicts include a reason. Database failures
still surface. The initializer reports blocked status without failing deployment,
so unrelated app functionality remains usable; root-required batches remain staged
until an editor resolves that specific setup problem.

No SQL data migration or new authority table is needed: new installs and upgrades
both run the existing initializer. Rollout must inspect its ownerRoot result and
follow up blocked installations. Existing saved anchors are preserved. This code
is local until review/publication/deployment; calling currently deployed documents
does not install it. Tests use synthetic identities and local databases only.

Final local verification on main base `2e7f8a293f5eb3fa91c8830a40ab8bee87be8840`:
155 Onto integration tests, 125 Onto unit tests and 42 repository tooling tests passed.
The operational test package rebuilt successfully; Astro check reported zero errors
and warnings (four hints), and actionlint and diff checks passed. Independent review
covered initialization, archive compatibility/concurrency, fixture corrections and
the current-main Ontology guidance. These are local checks, not a production rollout
or a live model evaluation. The existing missing live roots were not mutated.

### Portable copies and legacy owner IDs

New bootstrap records use `stableGraphId("onto:installation-owner-root:v1", kind,
ownerId)` and a slug containing that full derived ID. Installation ID and invoking
actor are deliberately excluded: two installations for the same owner represent
the same logical account/organization; different owners do not collide on a generic
slug. The hash is a record identifier, never authorization. An occupied derived
identity that is not the verified root is blocked rather than overwritten.
Existing authored canonical root IDs and slugs remain unchanged.

Consequently, an older installation with an arbitrary canonical root ID may still
need explicit archive reconciliation when restoring into a fresh auto-initialized
destination. Whole-app archive and Wiki transfer now refuse newly ambiguous exact
organization bindings instead of silently adding a second owner root. Existing
unique external-key checks likewise reject a second personal account for the same
principal. Neither path fabricates a merge or deletes the generated root.

For a whole-app archive, an editor who has independently verified the SAME owner
can use the SDK's existing explicit source-ID → destination-ID `map`, including the
source canonical root ID and the installation ID. Preview first and inspect its
revision/conflict result; ordinary archive revision rules remain intact. Do not map
a different owner's root onto the destination owner, and never choose this mapping
by a matching title. ID remapping applies to graph references as well as records;
no new automatic alias/merge mechanism is introduced. Wiki's separate add-only
transfer does not offer that map and continues to require explicit reconciliation.
This is an operator-controlled restore, not evidence that arbitrary imported graph
metadata can establish installation authority.

Whole-app archive imports now capture a graph snapshot before the app's binding
validation and prepend the existing snapshot guard to the SDK's atomic import
transaction. A competing bootstrap or root edit causes a 409 and rolls back the
entire import; the operator must preview again. The closure is request-local and
the archive cannot import the graph_changes authority table containing the guard.
The SDK's per-record revision checks, exclusions and preview token still apply.
Wiki's add-only transfer uses the same existing snapshot mechanism. Neither path
creates a global uniqueness constraint on every direct graph edit: an explicitly
introduced ambiguous graph still fails closed until its bindings are reconciled.

A multi-page whole-app restore remains page-by-page, not one transaction across all
pages. Each page has its own preview and guarded commit; a later conflict does not
roll back earlier successfully imported pages. Keep the archive, mappings and
receipts, resolve the conflict explicitly, and preview remaining work again. Do not
report a partially completed restore as complete.
