# App-owned graph definitions

Contribute through your app’s `graph/definitions.ts`. Each entry has a stable name and a scope. The `standard` entries make up Onto’s default registry. An `addon` retains the owning app’s setup lifecycle. A `fixture` is for demo or test data. Keep definitions in app source and import them into that entry.

In authored definitions, use the owning app namespace and the public type name, such as `onto:Person` or `planning:Project`. Refer to a node by the namespace of its authored record, followed by type name and slug, such as `onto:Project:mezi`. A relationship names its predicate in `typeId` and its directed endpoints in `fromId` and `toId`. Use `aliases` for additional authored addresses. The deployed graph still exposes its existing addresses, such as `Project:mezi`.

Keep an existing record’s explicit `id` when migrating a seed or moving its owning file. New records can omit the ID. The compiler derives it from the authored address. Give a new relationship a stable `key` so the endpoints can evolve without changing its identity. Choose names and relationship keys before shipping. If a shipped address moves, pin the old generated ID.

Dependency installation, package builds and SDK publication compose the registry. To regenerate local declarations after editing definitions, run `npm run graph:compose`. The composer validates types, aliases, record identities, relationship endpoints, and direction. Outputs belong in each app’s gitignored `graph/.compiled/` directory. The SDK’s standard rows, GraphQL SDL, and typed declarations are generated from the same registry and included in the published SDK archive.

Existing installations continue to use their UUIDs and seed ownership rules. Add-ons use their existing setup operations. Video Production’s historical registry is built separately because it predates the shared CreativeBrief and Storyboard definitions. The isolated exploration fixture also compiles separately because it is served from a different in-memory graph.
