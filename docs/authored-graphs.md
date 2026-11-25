# App-owned graph definitions

Contribute through your app’s `graph/definitions.ts`. Each entry has a stable name and a scope. The `standard` entries make up Onto’s default registry. An `addon` retains the owning app’s setup lifecycle. A `fixture` is for demo or test data. Keep definitions in app source and import them into that entry.

In authored definitions, use the owning app namespace and the public type name, such as `onto:Person` or `planning:Project`. Refer to a node by the namespace of its authored record, followed by type name and slug, such as `onto:Project:mezi`. A relationship names its predicate in `typeId` and its directed endpoints in `fromId` and `toId`. Use `aliases` for additional authored addresses. The deployed graph still exposes its existing addresses, such as `Project:mezi`.

Keep an existing record’s explicit `id` when migrating a seed or moving its owning file. New records can omit the ID. The compiler derives it from the authored address. Give a new relationship a stable `key` so the endpoints can evolve without changing its identity. Choose names and relationship keys before shipping. If a shipped address moves, pin the old generated ID.

Dependency installation compiles the app-local files under each app’s gitignored `graph/.compiled/` directory. After editing definitions, run `npm run graph:compose` and commit any changes under `packages/app-sdk/graph/` alongside the app declarations. Those generated standard rows, GraphQL SDL, and typed declarations let pinned SDK consumers install without running the apps repository’s scripts. SDK CI checks the committed snapshots against the app declarations. Use a conventional `fix` or `feat` commit or squash title so release-please can prepare an SDK release when the package changes.

The composer validates types, aliases, record identities, relationship endpoints, and direction. Graph inputs listed in `.outfitter/apps.json` also select Onto for app checks and previews. A successful main-branch check includes Onto in catalog publication so its standard registry follows changes from the contributing apps.

Existing installations continue to use their UUIDs and seed ownership rules. Add-ons use their existing setup operations. Video Production’s historical registry is built separately because it predates the shared CreativeBrief and Storyboard definitions. The isolated exploration fixture also compiles separately because it is served from a different in-memory graph.
