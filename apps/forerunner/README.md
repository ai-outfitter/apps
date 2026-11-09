# Forerunner

Forerunner has an operational **private manual board** and a read-only demo.
Both use the shared Outfitter shell and three card rows: stones, pebbles and sand.

## Manual discovery

Daily discovery reads the member's Gmail (else Calendar) every morning and is on
by default once Google is connected. Settings is one flat page: the daily run, the
connected accounts and the sources still to connect. Sources reruns one account at a
time. See [manual discovery](docs/manual-discovery.md) for the run, the schedule,
real-data local testing and the agent sample format.

## Manual board

Every person has their own personal Forerunner, served at `/apps/<id>/`: the
platform provisions it once, when their account is created
([app-build.md](https://github.com/ai-outfitter/webapp/blob/main/docs/app-build.md#apps-from-the-catalog)). In an
organization, an owner or administrator installs the operational package from
the catalog. Every member then starts with an empty private board. Members, including
organization administrators, can access only their own records in that
installation. Records persist in the installation's D1 database.

- Create, edit and delete stones (top-level priorities), pebbles (actions requiring
  a parent stone), and sand (small tasks with an optional parent stone).
- Each issue has a stable UUID, title, description, optional date, status
  (`todo`, `in-progress`, `done`), order, revision and timestamps.
- Move cards up/down within a category; complete/reopen them and toggle completed
  items. Completed stones remain available as parents until explicitly deleted.
- Reassign pebbles and reassign/detach sand before deleting a stone. A pebble
  cannot be detached; delete it if it no longer belongs to a stone.
- Concurrent edits and reorders return 409. The editor preserves its draft;
  **Reload board** adopts the latest revision without clearing the draft, then
  the member can review and retry. Each board supports up to 500 issues.

The app owns `/api/apps/forerunner/items` (GET/POST), `/items/:id`
(PUT/DELETE with `revision`) and `/items/reorder` (POST with the complete ordered
category as `{items: [{id, revision}]}`). The platform authenticates and forwards
the verified installation/member identity; every database operation scopes both.
SQLite triggers enforce parent scope and deletion restrictions atomically.

Operational installs also declare `graph.serve` and answer `graph.graphql`
(`src/server/graphql.ts`, printed to `graph/schema.graphql`): the calling member's
`items` and `discoveryRecords`, each paged by ID with `first`, `after` and `ids`,
items filtered by `category` and `status` and records by `kind`. A discovery
record's `data` is not served. Writes go through `graph.mutate` and the documents
in `src/server/documents.ts` (written to `graph/documents.json`, listed to agents by
`graph_documents` and run by `graph_mutate`): the board routes above and the
Settings daily-run toggle run the same CreateItem, UpdateItem, DeleteItem,
ReorderItems and SetDailyRun documents in process, so the UI and agents share one
path. Every member writes their own board; SetDailyRun requires an editor.

### Home card

Operational installs declare `home-cards.publish` and serve the reserved
`/api/internal/home-cards/v1/[operation]` route (platform dispatch only; see the
webapp's `docs/home-cards.md`). The `my-priorities` card lists the viewer's own
unfinished items in board order (stones, pebbles, then sand, each by position):
1, 3 or 5 at small, medium and large, plus open/in-progress counts at large.
Each item links to `/?item=<id>`, which the board scrolls to and focuses.

Its `complete-item` action takes `{ itemId }` and the item revision shown on the
card and completes through the board's own scoped `updateItem`: no editor gate,
and administrators reach only their own items. Another member's or a missing
item is the same 404; an already-done item answers `unchanged`; a stale revision
answers `conflict` without changing anything.

This first slice is entirely manual: no inbox/calendar ingestion, agent execution,
external issue synchronization, or automatic decision recording. Stable issue
identities and parent links leave room for later Linear/GitHub mappings without
coupling local data to a provider. Database/domain tests run on libSQL as well as
compiled Worker browser tests on D1; native Node managed-app hosting is not
implemented by this change.

## Demo access and delivery

The demo remains synthetic and read-only. **View demo** requires access to the
Demos organization; releasing an app does not grant that membership. Demo access
policy is unchanged. Unsupervised is an operational organization, so the previous
demo-only package could not be installed there; the new operational package
resolves that catalog restriction.

CI builds and publishes both immutable package modes. Its demo matrix updates
Demos and upgrades opted-in operational installations that already exist. An
initial customer installation remains an administrator action; CI does not create
it automatically. No platform release is needed just to update an existing app,
but the initial operational release includes new platform API routing.

## What the demo shows

`fixtures/forerunner-day.launch-week.json` (fixture 1, revision 2) is one Tuesday
for a synthetic operations lead. Every record has a stable ID that the pages,
the agent panel and the tests read.

- **Stones** (`stone.*`) are the highest-priority projects, ranked. Each links
  its **inbox signal** (`signal.inbox.*`), **calendar commitment**
  (`commitment.cal.*`), progress and blocker, and the **decision** only the person
  can make (`decision.*`, with `option.*` choices).
- **Pebbles** (`pebble.*`) are a stone's next actions, with owners.
- **Sand** (`sand.*`) is small decisions and follow-ups.
- The homepage has one horizontal card row for each of those three sections.
  Every card shows its priority and due date. Pebble and Sand cards link to
  their parent Stone.

`/` is the Today timeline, drawn from `fixtures/forerunner-today.json`. The
sidebar pages Life, Home, People, Money, Body and Progress say they are coming
soon. `/priorities` shows the three card rows. `?priority=<stone id>` opens that Stone's
evidence and decision detail inside the Stones section on the server; with
JavaScript, selection updates history and moves focus to the detail heading.
Closing the detail returns to the three rows. `/settings` shows the flat
daily run, sources and Connect more sources rows, with nothing connected.

**Ask Forerunner** opens the shared `AgentSidebar` with the selected stone as its
focus (`forerunner-stone`). Each stone has its own fixture transcript: a briefing
and suggested questions with scripted replies, held in React state for the
page's life. The composer keeps an unsent draft on a stone change and asks the
visitor to keep or discard it for the new focus. Free text is not answered and
the draft is kept. Scripted
replies advise or draft; none claims something was sent, scheduled or decided.

## Read-only guarantees

- The manifest declares one `demo` mode with no capabilities.
- Middleware allows only GET and HEAD. The page policy, with Astro's hashes for
  the island's inline hydration scripts, has `form-action 'none'`, and
  `connect-src 'self'` only so pages swap inside the app shell.
- No inference, connector read, write, `localStorage` or `sessionStorage`. The
  panel's open state is not remembered (no `openStorageKey`).
- **Record decision** is disabled, and says why.

## Build and test

From this repository's root:

```sh
npm run build --workspace apps/forerunner -- --mode demo
npm run build --workspace apps/forerunner -- --mode operational
npm run check --workspace apps/forerunner
npm test --workspace apps/forerunner
npm run test:e2e --workspace apps/forerunner
```

The browser spec runs the compiled Worker in Miniflare. It checks desktop and
phone widths, selection and history, the panel's focus, dialogue, Escape and
phone inert behavior, and that no request is non-GET or to `/api/`, and that
nothing is written to storage.

## Package ownership and validation

This package owns its domain/fixture/manifest/browser tests and `catalog/cover.png` artwork. Its manifest declares `api.serve`, `home-cards.publish` and catalog presentation; generic platform contracts are documented [here](https://github.com/ai-outfitter/webapp/blob/main/docs/app-runtime-capabilities.md).

Run `npm test --workspace @ai-outfitter/app-forerunner` for unit and SQLite integration checks, and `npm run test:e2e --workspace @ai-outfitter/app-forerunner` for read-only demo and private manual journeys. Browser preparation and artifacts use public app-test interfaces. See [deferred roadmap and tracking](docs/roadmap.md).
