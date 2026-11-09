# Future SemLang integration

> Part of [the knowledge graph](../../../../docs/architecture/knowledge-graph.md), Outfitter's central architecture for Wikis, ontology, reads and writes.

The graph records are the editable source of truth. This app stores
named entity/connection types, properties, documentation, stable identities and
versioned ontology contracts, including `kind`, `relator`, `event` and
`assertion` stereotypes ([relators and assertions](relators-and-assertions.md)).
It has no inheritance or reasoning engine.
A future adapter can add semantic interpretation without complicating the
project workflows.

| Graph concept                           | Possible SemLang mapping | Malloy result                 |
| --------------------------------------- | ------------------------ | ----------------------------- |
| Project type                            | A Project concept        | A typed source                |
| A Meze project node                     | An instance              | A row                         |
| Stable entity or connection ID          | Declared identity        | Primary key                   |
| Property definition/value               | Typed field              | Source column                 |
| Technology-use connection with evidence | A relator concept        | Relationship source and joins |
| Source/target IDs                       | Declared joins           | Foreign-key relationships     |

Graph types correspond most closely to SemLang **concepts**. SemLang `type:`
declarations describe value domains such as ProjectId, Dollars or EmailAddress.
A future mapping must choose its own supported concepts explicitly; the current
app does not store or enforce that semantic classification.

The intended path is graph records -> typed relational views or snapshot ->
SemLang concepts -> Malloy queries. An adapter would preserve canonical app
references and expose typed source populations, rather than ask Malloy to query
arbitrary graph JSON directly. Current audit timestamps are not business
occurrence or validity times. A MetricDefinition page describes a metric; actual
measures need observations, calculation rules, units and a defined row grain.

A practical first experiment could export a versioned DuckDB snapshot and
validate real compiler diagnostics and join results. SemLang generation,
compilation, runtime queries, imports and a bundled dependency are all deferred.
Permissions and connector execution remain platform concerns.

Sources: [SemLang concepts](https://github.com/Unsupervisedcom/semlang/blob/main/docs/language-reference/concepts.md)
and [declarations](https://github.com/Unsupervisedcom/semlang/blob/main/docs/language-reference/declarations.md).
