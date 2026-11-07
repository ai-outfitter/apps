# Relators, symmetric relationships and assertions

> Part of [the knowledge graph](../../../../docs/architecture/knowledge-graph.md), Outfitter's central architecture for Wikis, ontology, reads and writes.

This builds on the [version 1 endpoint contract](ontology-contract.md). The shared
SDK's `ontologyContract`, `validityInterval` and `assertionBody` schemas are the
canonical definitions. Version 1 remains supported. Version 2 is explicit opt-in;
this release does not reclassify existing types or overwrite authored records.

## Relator participation

A relator remains an ordinary node. Its outgoing typed edges fill named slots.
For a Marriage type (replace illustrative IDs with the chosen stable type IDs):

```json
{
  "version": 2,
  "stereotype": "relator",
  "validity": "interval",
  "participation": {
    "slots": [{
      "name": "spouse",
      "edgeTypeId": "72000000-0000-4000-8000-000000000002",
      "participantTypes": ["71000000-0000-4000-8000-000000000005"],
      "min": 2,
      "max": 2
    }],
    "distinct": [["spouse"]],
    "uniqueBy": ["spouse"]
  }
}
```

`min` and `max` count active connections per slot; null `max` is unbounded.
Slot names and connection types must be unique within a relator declaration.
The connection type must be directed, stored, and compatible with any declared
endpoint types. Distinct groups require different participant IDs within and
across the named slots. `uniqueBy` prevents overlapping relators with the same
participant sets in those slots; it does not prohibit other relationships or
invent a global marriage policy.

Create the relator and its connections together with `graph.apply`. Incomplete
drafts stay outside the committed graph. Existing direct entity writes remain
available for edits that leave the graph valid; they cannot save an incomplete
active relator. Archiving a participant, a required connection, or a type also
validates affected relators. Archive a relator and all its active connections in
one batch when removing it from active context.

RoleAssignment can use separate `holder`, `role`, `scope` and optional `approver`
slots. `distinct: [["holder", "approver"]]` prevents self-approval only when that
policy is explicitly declared. The tests exercise that model with existing
Person, Role and Organization types; people keep their original identities.

## Business validity and relationship identity

Types opt into `validity: "interval"`. Nodes and edges can then carry a separate
`validity` field, for example `{"from":"2026-01-01T00:00:00Z","to":null}`.
Both endpoints are required; null means unbounded. ISO timestamps may include an
offset. Intervals are half-open: `from <= at < to`. Equal or reversed endpoints
are invalid. These dates do not replace audit creation/update timestamps.

Participation links inherit the relator's lifetime and cannot carry independent
intervals. End a marriage by setting its relator's `to`, retaining its participant
links. A new nonoverlapping relator can model a later episode.

Friendship can remain a direct edge with this contract:

```json
{
  "version": 2,
  "symmetric": true,
  "validity": "interval",
  "endpoints": {
    "from": ["71000000-0000-4000-8000-000000000005"],
    "to": ["71000000-0000-4000-8000-000000000005"]
  }
}
```

Symmetric endpoint sets must match. Identity and lookup normalize the unordered
pair; persisted edge IDs and original orientation remain stable. Reversed edges
with overlapping intervals are duplicates. Nonoverlapping episodes, including
ones stored in the same orientation, are allowed. Archived records remain
historical and do not reserve the active identity. The migration replaces the
old unconditional directed-edge unique index with a partial timeless active
index. The central overlap validator and full-graph transaction guard enforce
temporal and symmetric integrity for batches, entity writes, imports and native
seed setup; competing writers cannot both commit conflicting relationships.

## Read-only derived relationships

Declare a separate edge type with a projection:

```json
{
  "version": 2,
  "projection": {
    "relatorTypeId": "72000000-0000-4000-8000-000000000001",
    "fromSlot": "spouse",
    "toSlot": "spouse",
    "symmetric": true
  }
}
```

The Marriage relator with two spouses produces one `spouse_of` row with a stable
composite view ID and a source reference to that relator. No derived edge is
stored. Writes of the projection type are rejected, including archived writes.
Change the source relator or its slots instead.

The Wiki assistant's read-only `graph.relationships` tool accepts optional `typeId`, `nodeId`,
`fromId`, `toId`, `at`, `includeArchived`, `offset` and `limit` (maximum 500).
Symmetric lookup works from either participant and orients the returned row to
explicit endpoint filters. Without endpoint filters, a symmetric pair has one
canonical row, avoiding double counting. Each row identifies its source edge or
relator and its revision. A view is graph context, not proof of a real-world fact. Agents read the same
projections as GraphQL fields (`graph_query`, e.g. `spouseOf`).

Omitted `at` means now; explicit null returns all business intervals. A timestamp
returns that instant's population. `includeArchived` is separate from validity.
An archived relator projects only when its retained slots still form an
unambiguous valid population. This is not a general historical revision engine.
The existing Connections page shows these same views, symmetry and source links.

## Assertions and evidence

An ordinary node whose type has `{"version":2,"stereotype":"assertion"}` stores
a JSON `assertionBody` in its existing `body` field. It has these fields:

- `schemaVersion: 1` and `subject: {type, id, revision}` reference an existing node
  or edge in this Wiki. Batch assertion bodies may use a temporary subject ID;
  only that typed reference is resolved, never arbitrary evidence text.
- `stance` is `supports` or `refutes`; editable `status` is `proposed` or
  `withdrawn`. New and edited assertions must pin the current subject revision.
- `uncertainty` requires a reason and permits a reported confidence from 0 to 1.
  Confidence is not a calibrated truth score.
- `evidence` contains source provider/record IDs, optional HTTP(S) URI, quotation,
  observation time and SHA-256 content hash. Sources need not become Wiki nodes.
- `provenance` records the claimed method (`manual`, `inference`, `import`),
  generation time and optional agent/run IDs. These are claims, distinct from
  Wiki's server-recorded writer identity and audit timestamps.

A calendar title can support discovering a Person or a scheduled interaction.
It does not establish friendship, marriage, attendance or a completed meeting.
Saving an assertion never creates or promotes a domain relationship automatically.
No `confirmed` status or writable confirmation receipt is accepted in its body.

`assertion.inspect` (the Wiki assistant's tool, and the entity page's
`POST /api/apps/wiki-map/assertions/inspect`) returns the assertion, its current reviewed subject snapshot,
a `subjectHash`, whether the subject revision still matches, and current or
requested historical confirmation receipts. History is bounded to 100 receipts
and reports truncation. Evidence and subject snapshots from prior confirmations
remain in the immutable receipts even after records are edited.

The existing entity page displays source evidence, uncertainty and the reviewed
subject. A direct authenticated member with existing editor authority may press
**Confirm assertion** and affirm the dialog. The server records the member and
time only for the inspected assertion revision and subject hash. The page's
`POST /api/apps/wiki-map/assertions/confirm` requires `{id, revision, subjectHash, affirm:true}`;
OAuth clients, apps, resident principals and delegated entity writers cannot
manufacture member confirmation.

The hash includes the subject's declared slot connections, participants and type
definitions. Editing an assertion, its subject, its participants or the relevant
ontology invalidates current confirmation, even when an edge edit leaves the
relator node revision unchanged. Stale confirmation attempts return HTTP 409;
there is no automatic retry against unseen content. Receipts document member
confirmation, not legal authority, application permissions or independent proof.

## Persistence and rollout

Migration `0005_relators_and_assertions` adds nullable validity columns, replaces
the directed identity index, and creates the confirmation receipt table. It
changes no existing ontology definitions or graph records. All graph writers use
the same validation snapshot and compare-and-swap guard. Native seed setup stays
add-only and now validates the actual combined graph under a transaction guard.
Cross-app callers creating relators should use `graph.apply` for the complete
relator and participation batch rather than incremental entity creation.

Audits are read-only. Invalid existing definitions and records require explicit
repair before tighter constraints can be activated. Portable graphs retain
assertion bodies, validity, IDs and source node/edge revisions. The full export
also has an owner/installation-labelled `confirmationArchive` with immutable
review evidence. Confirmation receipts cannot be imported as authenticated
approvals into another installation; imported assertions require fresh review.
Historical pins remain historical during repeated restores. Only newly added
assertions are checked for revision drift between source and destination.
When excluding canonical app records would break required participants or
assertion subjects, the export retains the full backup and returns no portable
transfer rather than producing a file that cannot be restored.
If an asserted subject already exists at a different revision, transfer returns
409 and asks for reconciliation rather than silently importing a stale claim.
Archived subjects cannot receive current confirmation. A successful confirmation
must have a receipt for the confirming member, including when another member has
already confirmed the same assertion.

RDF storage, an ontology reasoner, automatic inference, a relator creation wizard,
Governance control execution and SemLang/Malloy compilation are separate work.

**Planned:** discovery runs will write proposals and their evidence through
[Wiki change batches](../../../../docs/plans/wiki-change-batches.md), and items at
0.95 confidence or above will be committed by policy with a server-authored
`accepted_by_policy` record. That record is separate from member confirmation:
it never creates a confirmation receipt, and assertion bodies still accept no
`confirmed` status. See [discovery runs](../../../../docs/plans/wiki-discovery-runs.md#confidence).

See [measurable goal and control pilots](relator-control-pilots.md) for edge/relator selection, evidence rules, and migration costs.
