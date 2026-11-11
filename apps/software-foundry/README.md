# Software Foundry

Software Foundry is the Outfitter app for approved GitHub issue and delivery workflows. The demo contains staged data; the operational package uses an installation database, scoped storage, connectors and workflow packages.

Run `npm run check --workspace apps/software-foundry`, `npm run test --workspace apps/software-foundry`, and `npm run build --workspace apps/software-foundry` from the repository root. Browser tests require Playwright Chromium. The tests for the real Wiki integration require `OUTFITTER_WIKI_PACKAGE` to point to a built Wiki operational package; otherwise those two cross-app scenarios are reported as skipped. Run them in an environment with the Wiki package before accepting a change to the integration.

## Enabling a repository

Foundry starts work only on repositories its organization installation has configured (role bindings plus an issue subscription). Otherwise `RequestChanges` records the issue and answers "execution is not configured for this repository". An operator with the workspace gateway token enables a repository in the Outfitter organization, and can repeat it after any Foundry change to the bindings:

```sh
npm run configure-repository --workspace @ai-outfitter/app-software-foundry -- ai-outfitter/apps --gateway-token-from-kubernetes
```

It prints the approved subscription and an inspection that must show `configurationValid: true` with reviewer `vega-unsup`. The repository's gating checks come from `foundryChecks` in `src/server/workspace/workspaces.ts`. Configure only after the Foundry change that sets them is deployed, because the bindings record the checks at approval time.
