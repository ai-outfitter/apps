# HTML Starter

Edit `index.html` to change this complete single-page app. The same HTML is packaged in demo and operational modes, with no app capabilities or stored records. The platform answers `GET /api/whoami` after authenticating the viewer and checking installation membership. The Worker cannot manufacture identity or credentials.

From the repository root, install dependencies with `npm ci`, then run `npm run build --workspace @ai-outfitter/app-html-starter` and `devenv shell -- npm run test --workspace @ai-outfitter/app-html-starter`. The build writes both packages to `.outfitter/packages/`. The browser test runs the packaged Worker and stubs identity responses; it does not establish live authentication.

Install the demo in Demos or the operational package in an organization from the Outfitter app catalog. Preview builds use demo mode. Official releases publish both packages with source provenance; the platform currently adopts releases through a reviewed descriptor update.
