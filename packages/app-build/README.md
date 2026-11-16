# Outfitter app build

Run `outfitter-app-build` in an app directory to package all declared modes.
Use `--mode demo --output dist/preview.json` for PR previews. The output contains
the same `{manifest, artifact}` contract accepted by Outfitter installations.
Default outputs live in `.outfitter/packages/<mode>.json` within the app.
The build resolves installed dependencies from the app; no platform checkout,
registry credentials or tenant secrets are required. Owned workflow dependencies
are validated and bundled from their installed packages.

## App dependencies

`app.json` names the apps this one needs in the same owner's account. List
their slugs, or map each slug to the semver range this app works with:

```json
"dependencies": { "onto": "*", "wiki-map": ">=0.1.5" }
```

The build writes the slugs to the package manifest's `dependencies` and the
ranges to `dependencyRanges`. Before an installation takes the new package the
platform checks the owner's active version of each dependency against its
range, and holds the update until the dependency catches up. State a range
when the app starts calling something a dependency only recently offered.
