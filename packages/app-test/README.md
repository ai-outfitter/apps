# App test host

`@ai-outfitter/app-test/worker` runs an explicit built app artifact in Miniflare.
It serves package assets and supplies forwarded member identity. Packages with a
manifest database receive an isolated D1 with their declared migrations. Demo or
fixture-only packages without a database receive no D1 binding or migration
ledger. `hasDatabase` exposes that distinction; accessing `database` without a
binding throws. A manifest `storage` stanza binds one R2 bucket per declared
bucket as `STORAGE_<BUCKET>`, private to the installation ID, as install does;
`bucket(name)` resolves to it for inspecting stored bytes. Always dispose the
returned host. `tests/fixtures/storage-app` is the reference storage app.

The host accepts a slug, artifact path (string or URL), and optional installation
ID. `call(path, member, { method, body, headers })` simulates authenticated
forwarding. Optional headers supply test context; identity headers come only
from the supplied member, so a call without one is anonymous. `dispatch`
accepts a complete Request for app-owned browser routing. `fetch(requestOrUrl,
init)` provides the same host with the standard request interface, keeping binary
bodies and `redirect: "manual"`. `assets` exposes the artifact's encoded assets for
byte comparisons. These are trusted test
interfaces, not session authentication or authority to call live Workers. Platform
admission, grants and cross-installation dispatch policy stay in platform tests.

A fourth argument, `{ workflowHost(scope) }`, gives a `workflow.host` app its
workflow host: `call(path, member, { workflowHost:
scope })` and `dispatch(script, request, { workflowHost: scope })` pass the scope as
the dispatch props the platform would, and the app's `workflowHost(locals)` calls
the stub the factory returns for that scope. A package test passes a double; a
platform test passes the real `workflowHostCall`. Requests without a scope carry
no host, and a caller header cannot claim one.

`@ai-outfitter/app-test/prepare` provides workspace build setup. An app's own
`pretest:integration` / `pretest:e2e` hook calls
`prepareAppTests(new URL("..", import.meta.url))` from its `scripts/` directory.
This refreshes workflow catalogs and builds the app's declared modes through the
shared build CLI, which skips modes whose inputs are unchanged. Failures stop the
package tests. Root dispatch prepares the selected apps itself and runs package
scripts with `--ignore-scripts`, so these hooks serve direct package runs. Tests obtain explicit artifact
URLs with `appArtifact(packageDirectory, "demo" | "operational")`; they do not
import private platform source or know the current artifact-cache layout.

The Worker host itself is independent of the working directory. The optional preparation adapter uses the repository workspace's public
build commands and current central cache. Relocatable build output is future build
tooling work, not an app-specific platform boot script.

Miniflare and the SDK are declared host dependencies. Host-contract tests belong
here and run through `test:integration`. App packages own their test dependencies,
scenarios, fixtures, Playwright config, browser routing and teardown.

`@ai-outfitter/app-test/playwright` exports `appPlaywrightConfig()`: package-local
`tests/**/*.browser.spec.ts`, `test-results/`, Chromium software rendering and
failure traces. Each app keeps its own config and declares `@playwright/test`.
`fulfillFrom(route, response)` answers a routed request with a Worker response, and
`routeReadOnly(page, origin, worker)` serves a demo while failing any write or
`/api/` request. Apps still own their fixture routes and teardown.
`@ai-outfitter/app-test/assertions` exposes `defined()` for narrowing expected
scenario values without importing platform test helpers.

`@ai-outfitter/app-test/threads` exposes `threadTestHost()`: the real thread
service on in-memory libSQL with a mock model, optional `platformTools` and
`admins` (who may open the debug view).

All app browser suites live with their apps and run through each app's
`test:e2e`. Platform host policy is tested with the platform, not here.
