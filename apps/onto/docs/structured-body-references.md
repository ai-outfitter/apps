# Structured body references

> Part of [the knowledge graph](../../../../docs/architecture/knowledge-graph.md), Outfitter's central architecture for Wikis, ontology, reads and writes.

A node type can declare `jsonSchema`. The shared ontology validator enforces it
on graph writes, including atomic graph.apply, imports and type changes. Upgrade
a type schema and its existing bodies in the same batch. Archived records are
retained without requiring a body migration. Initialization remains add-only.

The Wiki interprets these optional JSON Schema annotations for read-only page
diagnostics. They declare dependencies; they do not grant access or activate work.

- `x-wiki-reference`: `node`, `node-type` or `edge-type` on a string field.
  Resolve its stable ID against active records in the currently visible Wiki.
- `x-wiki-graph-path: true` on an object shaped as
  `{ name, min_matches, path: [{ edge_type_id, direction, target_type_ids }] }`.
  Begin at the current node, follow each `incoming` or `outgoing` step, filter
  endpoints by the declared active types, and count distinct terminal nodes.
  Zero or insufficient matches, missing types, archived records and incorrect
  directions produce a missing-requirement diagnostic. Paths are existential
  dependency checks, not query joins, per-participant validation or evidence.
- `x-wiki-source-binding: true` on a nullable string field. Null/empty is shown
  as unbound; a name is only declared, not verified against a provider.

Nested objects/arrays and local JSON Schema `$ref` definitions are supported by
the diagnostics. Checks use only visible records, so “missing” can also mean not
available in this scope. Missing references remain saveable in draft bodies;
JSON Schema shape violations do not. A consumer must enforce its own readiness
policy before compiling, evaluating or activating a plan.

Bodies with graph requirements display a compact requirements section, then
their record fields and an expandable structured definition. Field descriptions
continue to come from the type's JSON Schema. No ControlDefinition-specific
rendering or validation lives in the Wiki.
