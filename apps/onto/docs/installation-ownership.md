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

Organization batches no longer acquire an implicit root-node anchor. A collection
of sourced competitor, repository or interview evidence can be relevant without
being a subsidiary, customer or partner of the organization. Explicit caller-chosen
anchors still constrain connectivity. Personal batches retain their existing
account-linked Person anchor behavior. Evidence validation, authorization,
confidence policy, review findings and content-digest checks remain in place.

## Upgrade and reconciliation

This is a read-time correction with a changed default for newly opened organization
batches. It needs no schema/data migration or manufactured Organization node and
works for existing and newly initialized installations after ordinary package
upgrade. It does not rewrite graph records, Governance settings, stored anchors,
review receipts, approvals or actor permissions.

For pending batches, request a fresh review through the normal authorized workflow
after upgrade. Existing reviews remain historical evidence; do not edit their
findings directly or bulk approve held proposals. A saved implicit anchor from an
older version is indistinguishable from a deliberately chosen anchor. Preserve it:
a member can inspect and explicitly configure anchors through the existing API
before requesting review. Unrelated schema, evidence or scope issues can still hold
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
