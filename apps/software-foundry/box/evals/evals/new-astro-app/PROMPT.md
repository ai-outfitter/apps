# Add the Release Radar demo app

Teams want one page that shows what each repository shipped this week. Add a new Outfitter app, Release Radar, at apps/release-radar: an Astro app built like apps/hr (the reference app in this repository), demo mode only, serving staged data. It uses the SDK packages in packages/ through the npm workspace; do not change packages/ or apps/hr.

- apps/release-radar/app.json has id outfitter/release-radar, version 0.1.0, runtime cloudflare-workers-for-platforms, dataLocation managing-outfitter-instance, a demo mode with no capabilities, and catalog access demo-only with demo slug release-radar and name Release Radar.
- apps/release-radar/package.json is @ai-outfitter/app-release-radar version 0.1.0 with outfitter.kind app, depends on astro, @astrojs/cloudflare and the SDK packages like apps/hr, and has build (outfitter-app-build --mode demo), check (astro check), test and test:unit (node:test) scripts.
- src/fixtures.ts exports repositories: at least three staged repositories, each with a name and the pull requests merged this week (number, title, author, mergedAt), and a summarize(repositories) function returning, per repository, its name and merged pull request count, sorted by count descending.
- The page at / has the heading Release Radar and lists every staged repository with its merged pull request count, each linking to /repos/<name>.
- The page at /repos/<name> lists that repository's merged pull requests with number, title and author; an unknown repository name responds 404.
- Middleware like apps/hr's answers GET /__health with {"app":"release-radar","status":"ok"}, rejects methods other than GET and HEAD with 405, and sets the same Content-Security-Policy and Cache-Control headers as apps/hr.
- A node:test unit test in apps/release-radar/tests covers summarize, and the repository's npm test passes (it builds every app's demo package and runs its unit tests).
