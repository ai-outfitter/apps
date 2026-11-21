# Changelog

## Unreleased

- Read personal GitHub pull requests using the account connection owner and real connection ID through the shared SDK helper.

- Keep project detail available when bounded Wiki context has no release/evidence types, while retaining supported evidence paths and project scope checks.

## [0.1.3](https://github.com/ai-outfitter/apps/compare/planning-v0.1.2...planning-v0.1.3) (2026-11-21)


### Features

* **planning:** review screenshots and video as revision evidence ([#232](https://github.com/ai-outfitter/apps/issues/232)) ([79981a0](https://github.com/ai-outfitter/apps/commit/79981a02c0e6b0a5cff7f784d94993267d116dfc))
* Publish app daily updates and read them across member Wikis in Forerunner ([#246](https://github.com/ai-outfitter/apps/issues/246)) ([f319f36](https://github.com/ai-outfitter/apps/commit/f319f36ed9912594e5a19e51dd110e10e5d92889))


### Bug Fixes

* **planning:** render source links in evidence walkthroughs ([#243](https://github.com/ai-outfitter/apps/issues/243)) ([83d4e83](https://github.com/ai-outfitter/apps/commit/83d4e83ccf2c1804a11088aaef92614e103cccde))

## [0.1.2](https://github.com/ai-outfitter/apps/compare/planning-v0.1.1...planning-v0.1.2) (2026-11-17)


### Features

* **app-sdk:** queries run in the owning app's database, GraphQL follows Relay connections ([#215](https://github.com/ai-outfitter/apps/issues/215)) ([5be3e24](https://github.com/ai-outfitter/apps/commit/5be3e2491beef8848a00d6a92f37b3dc83fc3cee))
* deliver personal portfolio and daily reports ([c1a2c03](https://github.com/ai-outfitter/apps/commit/c1a2c03de78105602cc6a17e9aced640f16b33a1))
* **planning:** design partners file feature and bug requests from their own organization ([#168](https://github.com/ai-outfitter/apps/issues/168)) ([68c1923](https://github.com/ai-outfitter/apps/commit/68c1923d3b6fba463469fcd3976ebcba3518b171))
* **planning:** link a project to its Onto Project node without a repository ([#141](https://github.com/ai-outfitter/apps/issues/141)) ([5bbee85](https://github.com/ai-outfitter/apps/commit/5bbee855565d9b9e2f178088b484968cd6f9d6d6))
* **planning:** record KPI measurements from connectors ([#158](https://github.com/ai-outfitter/apps/issues/158)) ([9c269ec](https://github.com/ai-outfitter/apps/commit/9c269ec6e1c3cfbc9e331ac8abcae790ab7fdb1f))
* share creative provenance across Marketing, Presentations and Workshop ([#191](https://github.com/ai-outfitter/apps/issues/191)) ([dfbd596](https://github.com/ai-outfitter/apps/commit/dfbd596b8b693f51a63bc992a19fe75d5d2b939b))
* **wiki, forerunner, planning:** one Wiki request per saved document, versioned dependencies, and a daily brief eval ([#216](https://github.com/ai-outfitter/apps/issues/216)) ([36cda66](https://github.com/ai-outfitter/apps/commit/36cda667c44e4dc9e25729f211d9751eb0fbe122))


### Bug Fixes

* **planning:** read published discovery as a contract fixture ([328855a](https://github.com/ai-outfitter/apps/commit/328855acdf171fe39be5d65fe71b6d66ac40be65))
* save scheduled daily reports before digest inference ([5e4fa61](https://github.com/ai-outfitter/apps/commit/5e4fa618d7c8b61a328bc08613b38340521ece3d))


### Performance Improvements

* **planning:** saved report reads ask for the Wiki package first ([#196](https://github.com/ai-outfitter/apps/issues/196)) ([5adc0cf](https://github.com/ai-outfitter/apps/commit/5adc0cf0250fcfa0bc7b5835a51030205d132ce8))

## [0.1.1](https://github.com/ai-outfitter/apps/compare/planning-v0.1.0...planning-v0.1.1) (2026-11-10)


### Features

* move Planning and Forerunner into the apps repo ([#80](https://github.com/ai-outfitter/apps/issues/80)) ([144beef](https://github.com/ai-outfitter/apps/commit/144beef23843642cd506d98ad86e00bb3eb3078a))


### Bug Fixes

* expose Planning issues and amend pending Onto batches ([#99](https://github.com/ai-outfitter/apps/issues/99)) ([278e24f](https://github.com/ai-outfitter/apps/commit/278e24fb0b635c09a8a4b660ebdafb09ebee1708))
* **planning:** drop the stale "no resident agent" sidebar line ([#124](https://github.com/ai-outfitter/apps/issues/124)) ([a37bb49](https://github.com/ai-outfitter/apps/commit/a37bb4929b54153282e3085adcdab1d51ce79070))
* **planning:** open the Planning-wide sidebar thread on pages that select nothing ([#100](https://github.com/ai-outfitter/apps/issues/100)) ([e4b1271](https://github.com/ai-outfitter/apps/commit/e4b1271e6fcddfdcedde7395529722a40e1739d9))
* **planning:** read the organization graph from Onto, as production Planning does ([#125](https://github.com/ai-outfitter/apps/issues/125)) ([c33e5c9](https://github.com/ai-outfitter/apps/commit/c33e5c9064f22c5ae02d0b85a520eca3d86cf0a4))

## Unreleased — marketing video production

- Add versioned storyboard packets, pinned sources, take submission receipts and private verified media uploads through published GraphQL documents.
- Display productions, sources and alternate takes in Planning, with authenticated MP4 downloads and filenames containing the storyboard version.
- Include local fal execution and FFmpeg assembly utilities; generation requires an authorized media executor and is not triggered by page reads.
