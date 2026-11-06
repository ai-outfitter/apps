# Outfitter app build

Run `outfitter-app-build` in an app directory to package all declared modes.
Use `--mode demo --output dist/preview.json` for PR previews. The output contains
the same `{manifest, artifact}` contract accepted by Outfitter installations.
Default outputs live in `.outfitter/packages/<mode>.json` within the app.
The build resolves installed dependencies from the app; no platform checkout,
registry credentials or tenant secrets are required. Owned workflow dependencies
are validated and bundled from their installed packages.
