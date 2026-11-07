# Official Outfitter apps and shared tooling

This repository will host official apps under `apps/<app>/` alongside reusable
Actions, workflow orchestration and tooling tests. Keep domain tests, fixtures,
migrations and release metadata with each official app. Personal apps remain in
external caller repositories and use the same shared tooling. Migrate official
apps separately after establishing the workflows; keep the hosted platform outside this repository. The SDK and its public
dependency closure live in packages/* here. Preserve independent app checks and releases as apps arrive.
Run `npm test` and actionlint before pushing. Test flat personal and workspace
organization layouts. Never assume package scope, modes, or browser tests.
Pin workflow references to reviewed commits. Workflows pin the shared Action
separately; when Action code changes, commit it and update these pins in a follow-up
commit. Dependabot groups Action upgrades. Do not publish major tooling/app
versions or use breaking-change commits without explicit authorization.
Metadata validation is not full app validation. Deployment acceptance is not
activation. Private SDK preview access requires reviewed dispatch or explicit caller
authorization of both the same-repository PR author and triggering actor.

PR previews use demo packages only. Keep build and publication jobs separate;
never expose hosting credentials to app builds. The private SDK preview adapter
uses a read-only deploy key and a pinned toolchain. Automatic private SDK builds
require both author and triggering actor in the caller's explicit allowlist; forks
and untrusted authors never receive private checkout access. Verify
the served source SHA and actual page/assets before reporting a preview as live.

The public SDK is canonical here. App builders and test hosts must work without
private webapp source. Release-please owns package versions and dependency bumps.

App deployment follows successful default-branch checks through OIDC. Do not add
deployment enablement flags. SaaS is the default destination; self-hosting changes
the destination and runner reachability, not the repository identity contract.

Graph interoperability follows [graph providers](docs/graph-providers.md). Keep generic discovery/transport in the SDK and product ontology/assertion/batch schemas in Onto contracts. A source reference or declared capability grants no access. Preserve legacy aliases until consumers and deployed data have a verified migration.
