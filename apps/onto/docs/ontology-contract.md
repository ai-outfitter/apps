# Wiki endpoint contract, version 1

> Part of [the knowledge graph](../../../../docs/architecture/knowledge-graph.md), Outfitter's central architecture for Wikis, ontology, reads and writes.

Wiki types may opt into a machine-readable `ontology` definition alongside the
existing property definitions and optional body JSON Schema. Type IDs remain
canonical; names and prose do not determine validation.

For an edge type connecting a Person to a Product:

```json
{
  "ontology": {
    "version": 1,
    "endpoints": {
      "from": ["71000000-0000-4000-8000-000000000005"],
      "to": ["71000000-0000-4000-8000-000000000015"]
    }
  }
}
```

Both lists must be nonempty and identify existing node types. Endpoint
constraints belong to edge types. Each active edge must connect active nodes
whose type IDs match the declared direction. The contract does not infer
inheritance, symmetry or constraints from descriptions. A type without an
ontology contract retains its existing behavior. Unsupported contract versions
are rejected on input and reported by the audit if encountered in stored data.

## Audit before activation

Ask the Wiki assistant to run its `ontology.audit` tool with an empty input
to inspect current constraints. To preview a definition without changing data,
pass `{"proposal":{"typeId":"<existing-edge-type-id>","ontology":{...}}}`.
The result lists affected record IDs, rule names, field paths and messages.
The ordinary installation authorization applies; the audit is read-only and
available to readers.

Apply the reviewed definition through the existing type entity API or
`graph.apply`. Invalid existing relationships must be explicitly repaired or
archived before the constraint can be activated. This release does not
automatically opt definitions into ontology enforcement or repair existing records.
Repeatable initialization validates missing seed additions against installed
contracts. Incompatible additions fail with 400; concurrent changes return 409
and may be retried. Initialization retains the existing narrowly scoped refresh
of untouched seed documentation and preserves authored records.

## Write behavior

The shared validator checks the resulting graph for batch writes, individual
entity writes and portable imports. A batch may create the endpoint types,
nodes and relationships together. Nested ontology endpoint lists use stable
UUIDs; temporary batch references remain supported in their existing fields
(`typeId`, `fromId`, `toId`).

Unrelated legacy violations do not prevent a write. New violations, or existing
violations affected by an edited type, node or relationship, reject the write.
An active relationship therefore prevents archiving a required participant
unless the same batch also repairs or archives that relationship. Archived
relationships retain their endpoint IDs without requiring active participants.

Semantic failures use HTTP 400 with a structured body:

```json
{
  "code": "ontology_validation_failed",
  "errors": [{
    "recordId": "<relationship-id>",
    "rule": "endpoint.from",
    "path": "fromId",
    "message": "Choose an active from endpoint of an allowed type.",
    "operationRefs": ["$relationship"]
  }]
}
```

Contract-governed writes, contract activation, seed additions and imports verify
the full type/node/edge revision snapshot used for validation. Without contracts,
individual entity writes guard all definitions and their own affected records,
so unrelated edits can proceed. Batch idempotency and rollback remain unchanged.
Portable imports return HTTP 409
when their validated snapshot changes, without retaining a partial import or
an internal guard record. Snapshot checks scale with the whole graph, so large
Wiki performance and database statement limits remain a follow-up concern.

Storage remains the existing type metadata JSON column. Legacy property arrays
and existing `{fields, jsonSchema}` objects remain readable; new objects may
also carry `ontology`. Portable backups preserve the public definition.

## Version 2

[Relators and assertions](relators-and-assertions.md) extends this contract with
participation, symmetry, business validity, derived views and explicit member
confirmation. Governance execution, Forerunner generation and SemLang/Malloy
integration remain separate work.
