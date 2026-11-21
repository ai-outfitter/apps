# Standalone apps

An Outfitter app can run as its own product, with no Outfitter platform in front of
it. The same app code serves both: on the platform it trusts the identity headers and
workflow host the platform forwards; standalone, the SDK signs people in and answers
those itself. Workshop and Onto are wired for it: `npm run standalone` in either.
Onto loads its standard data when an owner runs
`POST /api/internal/app-initialize` once, as the platform does after install.

## Run Workshop locally

```sh
cd apps/workshop
npm run standalone        # OUTFITTER_STANDALONE=1 astro dev
```

Open the printed URL. You land on `/login`. Under `astro dev`, a name and email sign
you in. The first request applies Workshop's migrations to a local D1 database in
`.wrangler/state`. Design turns need a model; put these in `apps/workshop/.dev.vars`:

```sh
INFERENCE_API_KEY=...                       # any OpenAI-compatible endpoint
INFERENCE_BASE_URL=https://api.openai.com/v1  # the default
INFERENCE_MODEL=gpt-5-mini                  # set in wrangler.standalone.jsonc
```

## What standalone mode does

`outfitterApp()` (`@ai-outfitter/app-sdk/astro`) adds one middleware ahead of the
usual app middleware when `OUTFITTER_STANDALONE=1` (or `standalone: true`):

- **Database.** It applies the app's `migrations/*.sql`, after the storage table when
  the app declares buckets, to the `DB` binding on the first request, with the same
  ledger install uses (`migrateAppDatabase`).
- **Sign-in.** `/login` offers Google (when `GOOGLE_CLIENT_ID` and
  `GOOGLE_CLIENT_SECRET` are set) and, only under `astro dev`, a name-and-email form.
  `/logout` signs out. A signed `outfitter_session` cookie (HMAC with
  `SESSION_SECRET`) lasts 30 days. Anyone signed out goes to `/login`; `/api/*`
  answers 401.
- **Identity.** It drops every incoming `x-outfitter-*` header and sets the member's
  own, exactly as the platform forwards them, so `requestIdentity()` and the app's
  access checks work unchanged. The deployment is one organization (`ORGANIZATION`,
  default the app slug). People in `ADMIN_EMAILS` are owners with admin access and the
  rest are members with write access; with no admins named, everyone is an owner.
- **Workflow host.** `workflowHost(locals)` returns a host the app answers itself
  (`standalone-host.ts`): `workflow.start`, `read`, `collect`, `activity` and
  `active` over a runs table in the app's own database, `inference.generate` on an
  OpenAI-compatible chat completions endpoint with the step's declared settings and
  the platform's untrusted-data framing, `inference.image` on its images endpoint, and
  `identity.current`. Everything else answers 501: entities and actions of other apps,
  connectors, residents, schedules, threads and platform records.

Google sign-in needs an allow list: `ALLOWED_EMAILS`, `ALLOWED_DOMAINS` (matched on
the address or Google's `hd` claim) or `ADMIN_EMAILS`. With none set, no one may sign
in. The redirect URI to register with Google is `<origin>/login/google/callback`.

## Alpha evidence from story specs

Each app's value story is a story spec in `tests/stories` (Workshop:
`workshop-alpha-value-story`, Onto: `onto-alpha-value-story`), walked against the
app running standalone and captured step by step, as webapp's story specs are
(docs/release-artifacts.md there):

```sh
npm run standalone &                       # in apps/workshop or apps/onto
STORY_ORIGIN=http://localhost:4321 npx playwright test -c playwright.stories.config.ts
```

The JSON report becomes the alpha revision's evidence bundle in Onto.

## Deploy as one Worker

```sh
OUTFITTER_STANDALONE=1 npx astro build
npx wrangler d1 create workshop             # put its id in wrangler.standalone.jsonc
npx wrangler r2 bucket create workshop-main
npx wrangler secret put SESSION_SECRET -c wrangler.standalone.jsonc   # and the Google and model secrets
npx wrangler deploy -c wrangler.standalone.jsonc
```

## Not yet standalone

- Workshop's Wiki and Onto steps (product revisions, concept publishing, hardware
  setup) call other apps through `entities.*` and `actions.call`, so they answer 501.
  The plan is to install those apps beside it in the same Worker or make them optional.
- The shell still shows the Outfitter brand and breadcrumbs; `AppLayout` takes a
  `brand`, which a standalone build should set to the product's name.
- One organization per deployment. Multi-tenant mode (organizations, invitations)
  and the agent threads of Foundry come from moving more of the platform into the SDK.

## Moving platform pieces into the SDK

The SDK is the open-core side: MIT, published, and enough to run an app as a product.
The platform keeps what makes it a hosted, multi-tenant service. Next to move, in
order of what Foundry needs:

1. Threads and agent turns (`threads.*`, the resident/agent-task plane) as an SDK
   host over the app's own database, so Foundry's agent threads work standalone.
2. Workflow runs with steps, attempts and sessions (the platform's run store and
   `workflow-sessions`), replacing the minimal runs table here.
3. Inference provider resolution and usage metering (`inference-providers`,
   `inference-usage`), so a deployment can bring its own keys per organization.
4. Organizations, members and invitations, for multi-tenant mode.
5. App-to-app entities and actions inside one Worker, so a flattened install of
   Workshop, Wiki and Onto serves `entities.*` and `actions.call` locally.
