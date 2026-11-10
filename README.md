# Outfitter apps

Home for official Outfitter apps and the reusable CI, release and deployment
tooling and public SDK used by personal and organization app repositories.

Official app source lives under `apps/<app>/`, with each app's domain tests,
fixtures, migrations and release metadata. Personal apps stay in their owners'
repositories and consume the same shared workflows. HR is the first app being migrated. The public SDK lives under `packages/`; the hosted platform remains in its separate repository.

Planned layout:

```text
apps/                 Official apps, each checked and released independently
packages/             Public SDK, UI, workflow contracts, test host and app builder
.github/workflows/    Shared workflows and this repository's CI
scripts/              Shared tooling implementation and its tests
action.yml            Reusable tooling Action
```

See [public SDK distribution](docs/sdk-distribution.md) for the existing pinned
workspace checkout, GitHub release archives, and release versus cutover gates.

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

Apps that run Playwright may set `outfitter.browserTests: true` in their package manifest; the shared check tooling installs Chromium on CI before running that app’s scripts. Set `preview.commands` to a subset of validation commands when the separate app-check job already supplies those gates. The official-app release job produces a demo package and source/digest provenance for each independent release.

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

The release workflow accepts an optional explicit `release-token` override for
a GitHub App/PAT. Otherwise it resolves the calling repository's generated
`github.token` inside the runner job, where that token exists. The caller grants
the required contents/issues/pull-request write permissions. No secret inheritance. Release-please config, versions and changelogs stay in
the caller. Components release independently; no automatic merge, npm publication
or deployment. Shared root behavior changes need app-local release notes for each
affected component because release-please tracks component paths.

Keep release and deploy as separate caller jobs after the check job. The caller
chooses triggers, permissions and deployment environments. Successful default-branch
app checks should call deployment directly; no deployment enablement flag is needed.

## Official catalog deployment

The six official apps registered by the platform publish from successful app CI
on `main`. `check.yml` retains the exact checked packages and catalog metadata;
`catalog-deploy.yml` downloads those artifacts in a separate OIDC-authorized job.
It never rebuilds app code with publication credentials. The platform takes the
artifact hashes, records the source commit and workflow run, and reconciles
catalog demos and installations following that repository. Busy workflows defer
activation through the durable reconciliation queue. A published artifact or
accepted queue request is not proof that every installation is active.
The publication job succeeds once every selected artifact is accepted. Per-owner
activation failures or workflow deferrals appear as explicit warnings and remain
in the durable retry ledger; they do not force unchanged apps to rebuild.

Webapp retains reviewed app identity and compatibility policy. It resolves the
current catalog channel from the registry instead of pinning component releases
in source. Runtime GraphQL metadata follows each installation's exact active
package during a partial rollout. App updates require no webapp version-pin PR,
release tag or package version bump. Independent component releases and the
shared personal-repository workflow below remain available.

## SaaS and self-hosted auto deployment

`deploy.yml` accepts `apps`, `destination` (an HTTPS origin), `environment` and
`runner`. Use `https://ai-outfitter.com` for SaaS; set a caller repository variable
for a self-hosted origin. Supply a runner label that can reach private hosts;
GitHub-hosted runners need a publicly reachable HTTPS destination. The caller
explicitly grants `contents: read` and `id-token: write`. The deployment job uses
that caller's environment and OIDC repository identity.

A minimal caller adds deployment after its app-check job:

```yaml
deploy:
  needs: apps
  if: github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.apps.outputs.has_apps == 'true'
  permissions:
    contents: read
    id-token: write
  uses: ai-outfitter/apps/.github/workflows/deploy.yml@REVIEWED_COMMIT_SHA
  with:
    apps: ${{ needs.apps.outputs.apps }}
```

SaaS is the default, with no platform deployment secret, enablement flag or extra
wrapper. Before the first automatic update, connect the calling repository and
install the apps you want in the destination's Apps settings. Apps without any
subscribed installations report nothing to update without failing other deployments. That records the destination
owner and installer authority. For self-hosting, pass `destination`; networking
and the instance's runtime remain that instance's responsibility.

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

While the SDK is private, the optional `toolchain` preview adapter requires
a reviewed manual dispatch or both the same-repository PR author and triggering
actor in the explicit `trusted-build-actors` JSON allowlist. It also requires a
pinned `toolchain-sha` and a
repository-read-only `OUTFITTER_TOOLCHAIN_SSH_KEY` in the separate `preview-build`
environment. It runs the existing private adapter's checks/tests/packaging, then
builds the demo mode. No Cloudflare credential is available during that build.
The default allowlist is empty. Personal repositories can opt their trusted
authors into automatic builds without waiting for SDK publication. Untrusted
authors and forks cannot use private source access. Closing a PR still runs
cleanup automatically.

## Public SDK

`packages/app-sdk` and its supporting packages are public source, extracted from
webapp commit `5c8689d4939992cc73c9500e8f42e009152a522e`. The portable
`@ai-outfitter/app-build` CLI builds app-owned packages without platform code.
`@ai-outfitter/app-test/prepare` uses those app-local outputs. The platform still
has its existing copy during the consumer migration; removing it is a separate
platform change.

Until npm trusted publishing is configured, consumers check out this public repo
at the full reviewed `sdkSha` in `.outfitter/apps.json` into `.outfitter-sdk` and include
`.outfitter-sdk/packages/*` in npm workspaces. A committed lockfile pins the
dependency graph. Both shared `check.yml` and `preview.yml` read that SDK pin from caller config;
no private repository key is needed. Run `npm ci`, `npm run check:sdk` and
`npm run test:sdk` here.

SDK release-please runs automatically on main pushes. Its manifest tracks each
package independently; the node-workspace plugin updates dependent package pins.
Merging a release PR creates component tags and GitHub Releases, with public
`npm pack` archives attached by the same job. Registry publication to npm is not
configured yet. App versions and changelogs remain in their app repositories.

Pin the SDK once as `sdkSha` in `.outfitter/apps.json`. Check/preview workflows
and the platform repository build adapter use the same commit and root lockfile.
The optional workflow `sdk-sha` input remains an explicit override for existing callers.

## Onto extraction and shared graph contracts

The public [Onto app](apps/onto/README.md) retains the legacy `wiki-map`
installation identity during migration. [Provider interoperability](docs/graph-providers.md)
describes the public SDK discovery/read contracts and Onto-owned contracts.
[The Onto plan](apps/onto/docs/graph-database-plan.md) describes its scope as a
graph database; documents and reports belong to a separate Wiki app. The platform
architecture and full delivery sequence are maintained in
[webapp's Onto architecture](https://github.com/ai-outfitter/webapp/blob/main/docs/architecture/onto.md).
Old Wikis move to Onto by import into a fresh installation, not by upgrading in place.
