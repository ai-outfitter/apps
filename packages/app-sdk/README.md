# App SDK

Public source entry points for the existing authenticated app host contract:

- `@ai-outfitter/app-sdk/server`: forwarded identity, editor checks and bounded JSON responses.
- `@ai-outfitter/app-sdk/migrations`: package migration schema and executor.
- `@ai-outfitter/app-sdk/cloudflare/database`: installation D1 adapter.
- `@ai-outfitter/app-sdk/astro`: `outfitterApp({ app, contentSecurityPolicy, storage?, readOnly? })`,
  the Astro integration that serves `/__health`, keeps pages GET/HEAD, requires
  forwarded identity on `/api/*` and sets the app's headers, so an app needs no
  `src/middleware.ts`. The CSP applies to built responses without a policy of their
  own; `astro dev` sends none, because Vite serves dev CSS and scripts inline.
- `@ai-outfitter/app-sdk/cloudflare/middleware`: the middleware it registers.
- `@ai-outfitter/app-sdk/cloudflare/standalone`, `./standalone-auth`, `./standalone-host`: standalone
  mode, where the app signs people in (Google, or a form under `astro dev`), migrates its
  own database and answers its own workflow host calls, with no platform in front of it.
  `outfitterApp()` registers it when `OUTFITTER_STANDALONE=1`. See
  [Standalone apps](../../docs/standalone-apps.md).
- `@ai-outfitter/app-sdk/storage`: per-installation buckets, spaces, visibility and
  TTL (`storage()`, `storageRoutes()`, `storageMaintenance()`).
- `@ai-outfitter/app-sdk/cloudflare/storage`: the storage host over `STORAGE_<BUCKET>` bindings.
- `@ai-outfitter/app-sdk/graph-client`: the owner's graph provider; `queryWikiGraph()` runs
  bounded `graph.query` reads, `readWikiGraph()` reads the whole graph for exports and seeds.
- `@ai-outfitter/app-sdk/graph-markdown`: Markdown for graphs and records (`renderMarkdownBlock()`).
- `@ai-outfitter/app-sdk/structured-result`: whether a JSON schema fits strict structured output.
- `@ai-outfitter/app-sdk/ui-preferences`: the display-only `outfitter-ui` cookie and its forwarded header.
- `@ai-outfitter/app-sdk/workflow-inference`: the system prompt and untrusted-data framing of a workflow inference step.
- `@ai-outfitter/app-sdk/workflow-session`: the exported workflow session format, for replay and evals.

Only the Cloudflare adapter imports `cloudflare:workers`. Forwarded headers are
trusted only behind the authenticated platform dispatch boundary; this package
does not make a directly exposed Worker safe.

This is the existing host API, not the proposed capability-token/event SDK.

## Why a separate package?

`@ai-outfitter/server` owns platform identity/tenancy schemas, tenant resolution
and host policy. This package exposes the installed app side of that boundary:
forwarded identity, installation database adapters and app migrations. It adds
no second session or tenant authority. These APIs could be server subpath exports;
the separate package makes app dependencies and host adapters explicit as templates
become independently buildable. The package split itself is not a security boundary;
authenticated dispatch and authorization still enforce that boundary.

## Installation

This is an npm workspace included by the root `packages/*` glob. Run
`npm ci` once at the repository root, using the shared `package-lock.json`;
there is no separate SDK install or lockfile. App packages are also
workspaces, through `apps/*`. Packages declare their own dependencies so
the build graph can track ownership. Other repositories consume it as described
in [SDK distribution](../../docs/sdk-distribution.md).

`./workflows` owns installed-app workflow catalog, run and subscription wire types, plus a same-origin `workflowClient()` for the generic platform APIs. Workflow definitions reuse workflow-core types. Apps keep their own domain settings and presentation helpers.

## Page-aware app agents

`agent-context` (page claims), `agent-schema` (schema adapters and reviewed
patches) and the `AgentDatabase`/`AgentStatement` types in `agent-store` remain
for apps' own proposal and domain stores. Conversations, turns, leases and
images live in shared threads below.

## Shared threads

`@ai-outfitter/app-sdk/threads` is the public thread contract. Apps declare
`threads.use` to call the `threads.*` workflow-host operations and the browser
routes under `/api/platform/threads` (`threadClient()`), and `threads.provide`
to publish thread types and answer the platform's callbacks through
`threadProvider()` mounted at `/api/internal/threads/v1/[operation]`
(`types`, `prepare`, `tool`, `finish`, `deleted`, and `list`/`get`/`entries` for
read-only history types). The platform stores conversational threads, runs
replies and enforces ownership and visibility; apps keep their domain records,
proposals and receipts. Typed parts (`parseThreadParts`) keep unknown extensions
as structured `data` parts. `stableThreadId()` names one thread per app-chosen
context without a unique index. `SIDEBAR_THREAD`, `sidebarThreadId()` and
`HISTORY_BUDGET` name the platform's open-ended sidebar thread; `history: { budget }`
keeps such a thread's prompt bounded through compaction. Per-domain host operation maps use the
standalone `./host-operation` helper and are composed by `./workflow-host`.

## Workflow host

`@ai-outfitter/app-sdk/workflow-host` is the installed-app side of the workflow
host: a typed `operations` map (zod input and output per operation, with the
phases that may call it), `workflowHost(ctx | locals)` for the request-scoped
capability and `workflowPhaseHandler()` for the reserved
`/api/internal/workflow-host/v1` route. The platform-defined phase payloads
(`eventInput`/`eventResult`, `prepareInput`/`prepareResult`,
`finalizeInput`/`finalizeResult`) are exported as zod schemas. Only trusted dispatch props supply the
capability; identity headers alone never do.


Budgeted thread history may include `sources: [{ installationId, type, id,
revision }]` (at most four). The platform must authorize the same owner and load
that exact entity revision on every reply. Source snapshots are transient,
attributed untrusted context, never a transcript checkpoint or privileged
instruction. Unavailable access or revisions fail the reply visibly. Sources do
not claim thread coverage or permit dropping messages; the combined context is
bounded to 64 KiB. See the `threadContextSource` and `prepare.history` contracts.
