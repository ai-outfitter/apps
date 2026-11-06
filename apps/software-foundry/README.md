# Software Foundry

Software Foundry is the Outfitter app for approved GitHub issue and delivery workflows. The demo contains staged data; the operational package uses an installation database, scoped storage, connectors and workflow packages.

Run `npm run check --workspace apps/software-foundry`, `npm run test --workspace apps/software-foundry`, and `npm run build --workspace apps/software-foundry` from the repository root. Browser tests require Playwright Chromium. The tests for the real Wiki integration require `OUTFITTER_WIKI_PACKAGE` to point to a built Wiki operational package; otherwise those two cross-app scenarios are reported as skipped. Run them in an environment with the Wiki package before accepting a change to the integration.
