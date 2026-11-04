# Shared app tooling

Own reusable Actions, workflow orchestration and tooling tests here. App source,
domain tests, lockfiles and release manifests belong to caller repositories.
Run `npm test` and actionlint before pushing. Test flat personal and workspace
organization layouts. Never assume package scope, modes, or browser tests.
Pin workflow references to reviewed commits. Workflows pin the shared Action
separately; when Action code changes, commit it and update these pins in a follow-up
commit. Dependabot groups Action upgrades. Do not publish major tooling/app
versions or use breaking-change commits without explicit authorization.
Metadata validation is not full app validation. Deployment acceptance is not
activation. Never put private SDK checkout credentials in public PR checks.
