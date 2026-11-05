# Outfitter apps

Home for official Outfitter apps and the reusable CI, release and deployment
tooling used by personal and organization app repositories.

Official app source will live under `apps/<app>/`, with each app's domain tests,
fixtures, migrations and release metadata. Personal apps stay in their owners'
repositories and consume the same shared workflows. This PR establishes the
tooling first; official app migration follows separately. The platform and SDK
remain a separate repository boundary.

Planned layout:

```text
apps/                 Official apps, each checked and released independently
.github/workflows/    Shared workflows and this repository's CI
scripts/              Shared tooling implementation and its tests
action.yml            Reusable tooling Action
```

The official apps will use the same affected-app matrix and independent release
components as external repositories. Adding them must not make tooling-only
changes rebuild or deploy every app by default.

Call `.github/workflows/check.yml`, `release.yml` and `deploy.yml` at a reviewed
commit SHA. The workflows use the versioned composite Action in this repository;
checking out the caller never requires copying tooling into it. Workflows pin the
Action commit independently so the implementation is explicit and immutable.
Dependabot updates those references and caller workflow pins independently.

A caller's `.outfitter/apps.json` describes its layout:

```json
{
  "appGlobs": ["*"],
  "sharedInputs": ["apple-health.ts", "apple-health-test-host.ts"],
  "validation": "metadata",
  "commands": ["check", "test", "build"]
}
```

App discovery also reads npm `workspaces` (array or `packages` form). A package is
an app when it has `app.json` or `outfitter.kind: app`. Package names and paths are
independent of owner, scope and deployment slug. The graph includes non-app
packages and app-owned workflows; consumers are selected transitively. Shared
inputs support Node glob patterns. Unknown root changes and unavailable git
history select all apps; root Markdown documentation does not. Deleted paths and
both sides of renames participate. Source checkout uses complete git history.

`metadata` checks declared commands and manifest/release version consistency. It
does **not** execute app tests or builds. `scripts` runs `npm ci` with the caller's
root lockfile, then the named package scripts in the app directory. Keep build
output and test fixtures app-owned. Each matrix leg uploads a small validation
provenance artifact with app path, source SHA, tooling SHA and validation mode;
it does not publish app packages. Tooling's own tests run here, rather than in
every caller repository. Local development: `npm test`, or from a caller checkout
`node /path/to/apps/scripts/apps.mjs check`.

The check workflow exposes `apps` and `has_apps` and a stable `CI gate`. Pass
`baseline-workflow` if the caller is not named `ci.yml`. Main push selection is
cumulative from the last successful caller push, so failed builds are included
on the next attempt. Avoid cancelling main runs; callers may cancel old PR runs.

## Releases

The release workflow takes only an explicit `release-token` secret. Pass a GitHub
App/PAT token, or explicitly pass `github.token` when repository permissions allow
it. No secret inheritance. Release-please config, versions and changelogs stay in
the caller. Components release independently; no automatic merge, npm publication
or deployment. Shared root behavior changes need app-local release notes for each
affected component because release-please tracks component paths.

Keep release and deploy as separate caller jobs after the check job. The caller
chooses triggers, enablement, permissions, secrets and deployment environments.

## SaaS and self-hosted auto deployment

`deploy.yml` accepts `apps`, `destination` (an HTTPS origin), `environment` and
`runner`. Use `https://ai-outfitter.com` for SaaS; set a caller repository variable
for a self-hosted origin. Supply a runner label that can reach private hosts;
GitHub-hosted runners need a publicly reachable HTTPS destination. The caller
explicitly grants `contents: read` and `id-token: write`. The deployment job uses
that caller's environment and OIDC repository identity.

The existing platform contract landed in
[webapp #625](https://github.com/ai-outfitter/webapp/pull/625): request a GitHub
OIDC token with audience equal to the destination origin, then POST
`{"apps":["app-slug"]}` to `/api/app-repositories/deploy`. The platform validates
repository ID and source SHA against its enrolled repository/default head and
queues build/install work. An advanced default head can reject an older run;
retry on the latest commit. The client fails partial failures, including HTTP202
responses with `failed > 0`. Queue acceptance does not establish activation.
Deployment slug comes from `app.json.slug`, the operational catalog slug, or the
app directory basename. It must match the platform enrollment.

The destination must configure `BETTER_AUTH_URL` to its own origin, GitHub
integration, signing/verification and an operational build/runtime provider.
Older installations may need Update once to record their repository claim.
Installer authority and platform enrollment remain required. This client does not
provision hosting or authentication. Ocean's persistent operational runtime is
still tracked by [webapp #589](https://github.com/ai-outfitter/webapp/pull/589);
configurable destinations do not prove self-hosted runtime readiness.

The existing personal [deployment PR #2](https://github.com/ncrmro/outfitter-apps/pull/2)
overlaps this workflow. Use the shared caller instead of enabling both.

## Temporary private SDK adapter

`toolchain.yml` is an optional reusable workflow for the current flat-layout
private-platform adapter. A maintainer manually selects a reviewed full source
SHA. The caller provides `OUTFITTER_TOOLCHAIN_SHA` (full platform commit SHA) and
the explicit `OUTFITTER_TOOLCHAIN_TOKEN` secret through its protected `toolchain`
environment. It validates app checks, tests, both legacy modes and browser tests.
Never invoke it on an unreviewed PR or grant a public PR private SDK credentials.
The adapter modifies a disposable private checkout. Its legacy dependency install
is not reproducible solely from a source pin. It is separate from generic app
validation and will be removed when public SDK packages support locked installs.

## Pull-request previews

`preview.yml` discovers changed apps from the PR merge base, builds each selected
app, and publishes an isolated read-only demo with a stable hostname per
repository ID, PR number and app path. A separate publication job downloads the
build artifact without checking out caller source or executing app build scripts.
It verifies `/api/health` against the exact repository, source SHA and app before
posting the link on the PR. Closing the PR deletes only Workers in that PR's
preview namespace. Reopening rebuilds them. Deployment environments also link to
the verified URLs.

The normal `package` adapter uses a caller-owned npm lockfile and each app's
`preview:build` script. That script produces `dist/preview.json` (override with
`preview.output` in the repository configuration), containing a demo `manifest`
and a managed Worker `artifact` with modules and assets. The shared publisher
accepts no capabilities, database or storage bindings. It strips viewer cookies
and authorization, denies writes and platform APIs, and supplies only static
assets to the app. These previews demonstrate app UI with synthetic fixtures;
they are not customer installations or authenticated platform integration tests.

A thin caller invokes the shared workflow on same-repository PR opened,
synchronize, reopened and closed events, passing `pull-request` and the explicit
`CLOUDFLARE_API_TOKEN` secret. Keep that secret in the caller's `preview-publish`
environment and configure `OUTFITTER_PREVIEW_ACCOUNT_ID`. The current provider is
Cloudflare Workers (`workers.dev`) in the Unsupervised account; SaaS/self-hosted
installation destinations remain the separate main-branch deploy workflow.
Fork code is not imported automatically.

While the SDK is private, the optional `toolchain` preview adapter accepts only
`workflow_dispatch`, a reviewed current PR head, a pinned `toolchain-sha`, and a
repository-read-only `OUTFITTER_TOOLCHAIN_SSH_KEY` in the separate `preview-build`
environment. It runs the existing private adapter's checks/tests/packaging, then
builds the demo mode. No Cloudflare credential is available during that build.
This is a temporary manual step for personal apps, not automatic unreviewed
private-SDK execution. Closing such a PR still runs cleanup automatically. The
SDK-free official example demonstrates fully automatic PR publishing.
