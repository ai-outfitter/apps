# Outfitter apps

Home for official Outfitter apps and the reusable CI, release and deployment
tooling and public SDK used by personal and organization app repositories.

Official app source lives under `apps/<app>/`, with each app's domain tests,
fixtures, migrations and release metadata. Personal apps stay in their owners'
repositories and consume the same shared workflows. HR, HTML Starter, Workshop and Software Foundry live here. The public SDK lives under `packages/`; the hosted platform remains in its separate repository.

Planned layout:

```text
apps/                 Official apps, each checked and released independently
packages/             Public SDK, UI, workflow contracts, test host and app builder
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

Apps that run Playwright may set `outfitter.browserTests: true` in their package manifest; the shared check tooling installs Chromium on CI before running that app’s scripts. Set `preview.commands` to a subset of validation commands when the separate app-check job already supplies those gates. Production component releases register immutable source versions with Outfitter; CI build output is never the production deployment input.

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

## Production releases and scheduled updates

Release-please updates each app's package/app manifests and creates its component
tag and GitHub release. The shared `release.yml` uses its per-component outputs
to invoke `notify.yml`, which sends an audience-bound GitHub OIDC request to
`POST /api/app-repositories/releases`. Outfitter does not poll repositories.
A notification records the release and optional update requests; it does not
build, upload a production package, or activate an installation inline.

Each caller retains its release metadata and a thin release workflow. Grant
`contents: write`, `issues: write`, `pull-requests: write`, and `id-token: write`
to the caller. Pass `release-token` explicitly if release-please needs a token
override. Do not inherit all secrets. `release.yml` accepts caller-owned
`config-file`, `manifest-file`, `config-path`, `destination`, `environment` and
`runner`; default destination is `https://ai-outfitter.com`.

Configure update requests in `.outfitter/apps.json`, keyed by app path (or slug):

```json
{
  "releaseTargets": {
    "yoga-practice": [{"target": "personal/yoga-practice"}],
    "apps/workshop": [{"target": "platform/workshop"}],
    "apps/example": [{"target": "org/example", "repositoryId": "OWNER_SOURCE_BINDING_ID"}]
  }
}
```

Scopes select existing authorized bindings; they do not grant authority.
`personal` addresses a registered personal source, `org` an organization source,
and `platform` a registered platform publisher. Supply the source binding's
`repositoryId` when more than one owner matches. Configure each repository in
Outfitter and install the apps it should update. An omitted or empty target list
registers the release without requesting installation updates or a build.

Outfitter's scheduled tick reconciles recorded requests. It builds only for an
installation or demo that needs the version, or on first install. Builds execute
the public tooling directly in an isolated workspace, with pinned source and
tooling revisions and the committed lockfile. Successful packages are cached;
updates preserve owner authority, dependencies, migrations, readiness checks and
activation revisions. Failed builds leave the installed version running.
Queue acceptance is not completed build or activation: inspect Outfitter's
release/update receipts and installation history.

The notification body is:

```json
{
  "app": "yoga-practice",
  "tag": "yoga-practice-v0.1.1",
  "commit": "FULL_RELEASE_COMMIT_SHA",
  "targets": [{"target": "personal/yoga-practice"}]
}
```

A successful response identifies `releaseId`, `sourceCommit`, and durable
`requests` containing `id`, `target` and `status`. Outfitter verifies the GitHub
repository identity, published component release, source commit, manifest version
and target authority. Repeating a notification returns the existing records;
it cannot replace an existing release's commit.

If release-please succeeded but notification failed, rerun the failed notification
job. For recovery after a whole workflow rerun, dispatch the calling repository's
release workflow on its default branch with `releases` set to a JSON array of the
existing release objects above. Its thin wrapper passes that input to shared
`release.yml`; this preserves the calling repository's OIDC identity. Dispatching
the central workflow directly can only register the central repo's releases.
Release-please may produce no new outputs on a whole rerun;
manual notification never creates a new version or rebuilds in CI. The server
rechecks the existing release and the calling repository's authority.

PR previews remain in each app repository's Actions/Cloudflare pipeline. They do
not notify Outfitter. `deploy.yml` and its older push client remain compatibility
entrypoints for existing callers only; migrate callers to release notifications.
Migrated production apps do not require a webapp descriptor update, platform
build, R2 upload job or webapp deployment per release.

Self-hosted instances use the same identity and release protocol with a different
HTTPS `destination` and a reachable runner. Networking and runtime activation for
self-hosting are deferred; SaaS is the initial rollout target. Never add a
production deployment enablement flag.

See the platform's [app release architecture](https://github.com/ai-outfitter/webapp/blob/main/docs/architecture/app-releases.md)
for authority, reconciliation, hosted builds and transition status. Deploy the
platform support before switching callers; retain the previous deployment path
until the new scheduled lifecycle has been verified for both repositories.

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
installation updates follow the separate release-notification and scheduled-tick lifecycle.
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
