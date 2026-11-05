# Official Outfitter apps and shared tooling

This repository will host official apps under `apps/<app>/` alongside reusable
Actions, workflow orchestration and tooling tests. Keep domain tests, fixtures,
migrations and release metadata with each official app. Personal apps remain in
external caller repositories and use the same shared tooling. Migrate official
apps separately after establishing the workflows; keep platform/SDK code outside
this repository. Preserve independent app checks and releases as apps arrive.
Run `npm test` and actionlint before pushing. Test flat personal and workspace
organization layouts. Never assume package scope, modes, or browser tests.
Pin workflow references to reviewed commits. Workflows pin the shared Action
separately; when Action code changes, commit it and update these pins in a follow-up
commit. Dependabot groups Action upgrades. Do not publish major tooling/app
versions or use breaking-change commits without explicit authorization.
Metadata validation is not full app validation. Deployment acceptance is not
activation. Never put private SDK checkout credentials in public PR checks.

PR previews use demo packages only. Keep build and publication jobs separate;
never expose hosting credentials to app builds. The private SDK preview adapter
is manual-dispatch-only against a reviewed PR head with a read-only deploy key.
Do not call a manually reviewed private-SDK build automatic PR publishing. Verify
the served source SHA and actual page/assets before reporting a preview as live.
