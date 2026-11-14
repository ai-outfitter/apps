# Reusable context graphs

> Part of [the knowledge graph](../../../../docs/architecture/knowledge-graph.md), Outfitter's central architecture for Wikis, ontology, reads and writes.

A graph definition selects evidence; it does not own a role, trigger a workflow,
generate a prompt, grant authority, or publish a GitHub issue. Several roles,
tasks, triggers and document recipes can use the same graph with different roots.

The shared seeds provide three profiles:

- **Role operating context**: responsibilities, role assignments, scoped controls,
  goals and measures for humans and agents.
- **Decision context**: the decision/control, assignments, constraints, evidence
  and recorded outcomes needed for RAPID contributions and release assessment.
- **Delivery context**: scope, stories, requirements, acceptance criteria,
  dependencies and evidence used for specifications, issue drafts and reviews.

The canonical JSON body requires only `name`, `purpose`, `rootTypes`, and
`selection`. The JSON Schema is `../schemas/knowledge-graph-definition.json`.
Selection declares relationship types/directions, `maxDepth`, and `maxNodes`.
Inputs such as the root entity, RAPID responsibility and output recipe belong to
consumers, not to this reusable definition. Output renderers must preserve source
identities/revisions and distinguish missing evidence from verified facts.

A profile can reference vocabulary supplied by optional apps. The viewer reports
unavailable root/relationship types as context gaps and follows only types
installed in the authorized Wiki. At least one root and one relationship must be
available. This is not evidence that the unavailable domain was inspected.

Legacy Markdown definitions and `root_type`/`pattern` are still readable. New
seed records retain a legacy property projection for deployed clients that do
not yet read the structured body. Its primary root and supported relationships
must match the target installation's registry. Versioned Governance graphs are
retained until those consumers migrate; they are not equivalent root contracts.

Seed initialization remains add-only. Changing a seed does not overwrite or
archive existing records. The production cleanup is a separately authorized,
revision-checked, per-installation operation: snapshot first, create shared
profiles, move live graph references, deduplicate attachments, then archive
superseded definitions. Preserve historical evidence references and archived
records. Personal production Wikis are outside an organization-only cleanup.

## Wiki navigation

The Wiki home shows the organization selected by an existing, valid Governance home setting in the same Wiki, or the unique Organization whose `organization_id` matches the installation owner. Missing or ambiguous selection shows the organization directory; names are never treated as identity. A unique adopted BoardCharter for that organization is linked when present. Drafts are not presented as an adopted charter.

The sidebar lists collections, with only the current entity and its available graphs nested beneath its collection. The full reusable graph catalog remains at `contexts`; collection pages and the graph explorer retain access to every record.

## Organization chart

Organization and Board pages offer an org chart built from existing `part_of`, `scoped_to`, `assigns_role`, `assigned_to` and `reports_to` records. Board membership and organization role grouping are distinct from reporting lines. Assignment cards link to their source records; the detail list also links to role definitions and holders. Unrelated organizations and archived records are excluded. Ambiguous holder-to-position mappings and reporting cycles are reported rather than resolved by guessing. Proposed reporting relationships retain that label. This is an app view over the existing graph, not another saved bespoke knowledge graph.
