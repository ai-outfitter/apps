# Public SDK distribution

App repositories can consume the SDK from a reviewed public source commit.
They do not need a private SDK checkout or deploy key. GitHub release archives
are also published. These archives are not npm registry publication.

## Pinned public workspace checkout

This is the existing caller path. A repository includes
`.outfitter-sdk/packages/*` in its npm workspaces and records a full public
`ai-outfitter/apps` commit in `.outfitter/apps.json` as `sdkSha`. The reusable
[check workflow](../.github/workflows/check.yml) validates the pin and checks out
that public source before running the caller's locked install and app scripts.
Workflow and composite Action pins remain separate from the SDK source pin.

The current [personal apps caller](https://github.com/ncrmro/outfitter-apps/blob/main/.outfitter/apps.json)
pins `52adcbeae4dd8ea20ee8e02e84b4a34fbfe410e8`. Its
[root package](https://github.com/ncrmro/outfitter-apps/blob/main/package.json)
already declares the public SDK workspace. This path resolves the public
package dependency closure locally, including internal packages that are not
available from npm.

After the Onto source changes have merged, upgrade a caller separately:

1. Select the reviewed final public commit. Keep the full 40-character SHA.
2. Update `sdkSha` and check out that exact source in `.outfitter-sdk`.
3. Align the caller's direct SDK package versions with that checkout and update
   its root lockfile. A mismatched exact version can make npm try the registry
   instead of using a workspace package.
4. Run `npm ci`, app checks, tests and builds from a clean caller checkout.
   Verify both demo and operational packages where the app supports them.
5. Review and land the caller change separately. Updating SDK source
   does not authorize a production installation upgrade.

For a clean local checkout, the source preparation is:

```sh
git clone https://github.com/ai-outfitter/apps.git .outfitter-sdk
git -C .outfitter-sdk checkout --detach <reviewed-full-commit-sha>
# Align caller dependency versions and update its lockfile before this check.
npm ci
```

New callers should use the same public workspace path. Do not add a private
adapter to compensate for missing npm versions.

## GitHub release archives

The [SDK release workflow](../.github/workflows/sdk-releases.yml) runs
release-please and attaches `npm pack` archives to component releases through
[publish-sdk-archives.mjs](../scripts/publish-sdk-archives.mjs). It does not run
`npm publish` or activate apps. Recovery checks the package source against its
release tag before attaching an archive; an existing asset is left unchanged.

Verified release assets on 2026-11-07 include:

| Package              | Published GitHub archive                                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| app-sdk 0.1.3        | [ai-outfitter-app-sdk-0.1.3.tgz](https://github.com/ai-outfitter/apps/releases/download/app-sdk-v0.1.3/ai-outfitter-app-sdk-0.1.3.tgz)                      |
| app-build 0.1.5      | [ai-outfitter-app-build-0.1.5.tgz](https://github.com/ai-outfitter/apps/releases/download/app-build-v0.1.5/ai-outfitter-app-build-0.1.5.tgz)                |
| app-test 0.1.4       | [ai-outfitter-app-test-0.1.4.tgz](https://github.com/ai-outfitter/apps/releases/download/app-test-v0.1.4/ai-outfitter-app-test-0.1.4.tgz)                   |
| connector-core 0.1.1 | [ai-outfitter-connector-core-0.1.1.tgz](https://github.com/ai-outfitter/apps/releases/download/connector-core-v0.1.1/ai-outfitter-connector-core-0.1.1.tgz) |

An individual archive retains its package's internal dependency version ranges.
Installing one archive does not supply the remaining dependency closure. Use
the pinned workspace checkout unless the caller explicitly pins and validates
all required archives and records them in its lockfile. No automatic archive
installer or registry fallback is implied.

Anonymous registry checks on 2026-11-07 returned HTTP 404 for the 14 existing public SDK
packages checked before the new GitHub connector component, including `@ai-outfitter/app-sdk`, `app-build`,
`app-test`, `onto` and `onto-contracts`. Recheck actual tags, assets and
package versions before selecting a later release.

## Release and cutover prerequisites

For an SDK archive release, first land reviewed source and release-please
configuration for every new public package. Keep package metadata, dependency
versions and the root lockfile consistent. Let release-please prepare versions
and changelogs, then review its release PR. The release workflow needs GitHub
contents/issues/pull-request write permissions; archive upload uses the release
token override or the repository token. npm publishing credentials are not
required for this distribution path.

The Onto changes introduce `@ai-outfitter/onto-contracts` and
`@ai-outfitter/onto`. Their release components must remain registered, and SDK
consumers must receive the changed public dependency closure. Before installing
an operational package that carries `database.baselines`, the platform must
accept that metadata and pass it to the migration executor. Existing
installation data and consumer behavior still require upgrade acceptance.

Reviewed public source and SDK archives can land independently of production
consumer cutover. Keep current installation revisions and caller pins until
those upgrades are explicitly validated. The release-notification caller
switches in [apps #27](https://github.com/ai-outfitter/apps/pull/27) and
[personal apps #10](https://github.com/ncrmro/outfitter-apps/pull/10) have their own
platform rollout gate: deployed release registration, durable scheduled
reconciliation, isolated builds and verified activation. Publishing public SDK
source or archives does not satisfy that gate.
