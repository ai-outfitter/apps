# Reading Wiki entities

> Part of [the knowledge graph](../../../../docs/architecture/knowledge-graph.md), Outfitter's central architecture for Wikis, ontology, reads and writes.

Node pages identify the entity type independently of the sidebar. They show a
name, summary, recorded state/version, labeled related entities and an optional
schema-driven reading layout. No node name or type ID chooses a special renderer.

A type can put `x-wiki-presentation` in its existing body JSON Schema:

```json
{
  "version": 1,
  "entityLabel": "Control definition",
  "summaryPath": "description",
  "inputLabels": {"triggered_at_epoch": "Issue opened"},
  "tabs": [{
    "id": "measurement",
    "label": "Measurement",
    "sections": [{
      "title": "How it is measured",
      "fields": [{
        "label": "Measured value",
        "path": "programs.measurement",
        "format": "expression"
      }]
    }]
  }]
}
```

`overview` selects sections in the default tab. Other tab IDs must be unique;
`technical` is reserved for the reader's raw definition, properties and schema.
A field reads either a dot-separated `path` in the JSON body or a scalar record
`property`. An optional `suffixProperty` combines a value and unit. `format` is
`text`, `table`, `expression` or `decision`; `description` provides supporting
text. Arrays of records become tables, not nested numbered headings.

Expression/decision presentation renders ordered operator steps with human input
labels. It does not compile or evaluate the definition, infer compliance or
create evidence. Unsupported operators remain visible by name. Technical shows
the actual stored representation for inspection and copying.

Optional schema annotations describe read-only dependency checks:

- `x-wiki-reference`: `node`, `node-type` or `edge-type` on a stable ID.
- `x-wiki-graph-path: true` on `{name,min_matches,path}` objects, where each path
  step has `edge_type_id`, `direction` and `target_type_ids`. Paths start at the
  current node and count distinct active endpoints.
- `x-wiki-source-binding: true` on a nullable string; an empty value is unbound.
  A declared value does not prove source access or a running evaluator.

Unbound sources and missing graph paths produce a visible readiness message.
Detailed diagnostics live with the data/technical views. Checks see only records
in the current Wiki; missing can mean unavailable in the selected scope.

Ordinary Markdown nodes retain their documentation and get the same identity,
compact facts and related-entity layout. Assertion nodes retain their dedicated
review and confirmation controls. Existing connection and graph routes remain
unchanged. These display annotations confer no permissions and change no graph
validation or save rules.

The read-only demo includes a synthetic control at
`/example-controls/8ca861ad-e9c0-4ef4-950e-000000000003`; it is never seeded into
personal or organization Wikis. Forerunner's separate control seed can supply the
same presentation metadata without making the reader depend on Forerunner.
