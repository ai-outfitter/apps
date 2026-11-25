# Changelog

## [0.1.5](https://github.com/ai-outfitter/apps/compare/workshop-v0.1.4...workshop-v0.1.5) (2026-11-25)


### Features

* Publish app daily updates and read them across member Wikis in Forerunner ([#246](https://github.com/ai-outfitter/apps/issues/246)) ([f319f36](https://github.com/ai-outfitter/apps/commit/f319f36ed9912594e5a19e51dd110e10e5d92889))
* **workshop:** add print inspection and sliced plate evidence ([eef637d](https://github.com/ai-outfitter/apps/commit/eef637da88a2f043b9a21bc70534f6d581d4356c))
* **workshop:** attach and verify CAD and animation files on saved parts ([d65c283](https://github.com/ai-outfitter/apps/commit/d65c283de5986946da706a8ba9e7f5737bfceffb))
* **workshop:** consolidate assembly viewing on the project overview ([ac69120](https://github.com/ai-outfitter/apps/commit/ac69120351ab600f5ad3cf74b7755f8b37d551f6))
* **workshop:** distinguish estimated unit costs in referenced build prices ([7415d10](https://github.com/ai-outfitter/apps/commit/7415d1059ccec2826e7476abc479539d42ede2ea))
* **workshop:** import verified PCB packages through MCP ([#234](https://github.com/ai-outfitter/apps/issues/234)) ([0e38161](https://github.com/ai-outfitter/apps/commit/0e3816153b8add35871dc5ab66b5c4b7ed136714))
* **workshop:** inspect components directly from a top assembly view ([#236](https://github.com/ai-outfitter/apps/issues/236)) ([bc51915](https://github.com/ai-outfitter/apps/commit/bc519155cf4e857e9af52b43dfae41a48438c7f8))
* **workshop:** inspect installed covers and model sizing ([d2fbb9e](https://github.com/ai-outfitter/apps/commit/d2fbb9e0fd685c33d72f33ad762bc6a5371c07e0))
* **workshop:** pick installed assemblies and drill into their members ([#237](https://github.com/ai-outfitter/apps/issues/237)) ([7949171](https://github.com/ai-outfitter/apps/commit/79491711a6846bc9b4947fda2e0ca7b2fb034261))
* **workshop:** play installed joints and transfer props in named operations ([fe839c3](https://github.com/ai-outfitter/apps/commit/fe839c39afdfdd78f607febefe2b742aa901f5b3))
* **workshop:** publish revision-checked assembly reads and saves ([c4ae915](https://github.com/ai-outfitter/apps/commit/c4ae9158e2f564e5f8d474b605de7711ca85b79b))
* **workshop:** resolve CAD opacity and roll up build prices ([0e3f225](https://github.com/ai-outfitter/apps/commit/0e3f225f2a879bc938d65f33d170f3892790fff2))
* **workshop:** resolve configured assembly references across projects ([c87c53e](https://github.com/ai-outfitter/apps/commit/c87c53e9b5889bd6a6c6c9f876d59ee478a720df))
* **workshop:** separate products from reusable component models ([#251](https://github.com/ai-outfitter/apps/issues/251)) ([84a672e](https://github.com/ai-outfitter/apps/commit/84a672e8071595d60ed58d9e6c4fdc07794900b7))


### Bug Fixes

* **graphql:** preserve complete fields alongside paged results ([027287c](https://github.com/ai-outfitter/apps/commit/027287cd0b04f9039c9e515096a064cb83690f9d))
* **workshop:** allow saved assemblies with more than 200 items ([ac17fcf](https://github.com/ai-outfitter/apps/commit/ac17fcff9ad0789494a2054a7dd3a602ffa7589d))
* **workshop:** fit resolved pages within the default graph budget ([baf97e8](https://github.com/ai-outfitter/apps/commit/baf97e8b23ac8b86795407974cdbc5dbd0335e89))
* **workshop:** keep motion status with the model on narrow screens ([68fcde7](https://github.com/ai-outfitter/apps/commit/68fcde732d3637f3a70fba4f13da556d5c1fcfe8))
* **workshop:** lead the BOM with the combined one-build price ([ed3c68f](https://github.com/ai-outfitter/apps/commit/ed3c68f7fb685e189e5f20ff4e58d432b8a0bdf7))
* **workshop:** load project views without WebGL and clarify assembly navigation ([35c49aa](https://github.com/ai-outfitter/apps/commit/35c49aa3b0a2840993aa34ae35c69d72a98259d1))
* **workshop:** match reviewed personal catalog policy ([#227](https://github.com/ai-outfitter/apps/issues/227)) ([5600f86](https://github.com/ai-outfitter/apps/commit/5600f86ac29d617d8edb389790bae9e9a8b82a4b))
* **workshop:** page complete resolved assemblies with a snapshot digest ([61ea5e1](https://github.com/ai-outfitter/apps/commit/61ea5e18a30161fba85ce35b30753b2159951e0f))
* **workshop:** play saved drive motion through installed references ([d87443e](https://github.com/ai-outfitter/apps/commit/d87443e2aa7a4366f06e5426252595dd07269e83))
* **workshop:** preserve assembly references across builds and nested reads ([405fa05](https://github.com/ai-outfitter/apps/commit/405fa054781ad0752244d793a14634411cf94cfb))
* **workshop:** preserve unaffected placement IDs when binding saved motion ([8bb08a3](https://github.com/ai-outfitter/apps/commit/8bb08a3fb7517834a9cafaabc19cc5a1e42efe18))
* **workshop:** preserve verified attachment provenance on assembly edits ([bb0710a](https://github.com/ai-outfitter/apps/commit/bb0710a335ba32fdf1877becc67adff0f3355144))
* **workshop:** publish component classification operation ([#253](https://github.com/ai-outfitter/apps/issues/253)) ([28cb573](https://github.com/ai-outfitter/apps/commit/28cb573b068b73c7bc700ee2160ea85d0a95ce46))
* **workshop:** publish the updated assembly input contract ([4c49d51](https://github.com/ai-outfitter/apps/commit/4c49d51b96b1780438c8234e23822a64d78672ef))
* **workshop:** put assembly motion controls beside the CAD viewport ([d410f7d](https://github.com/ai-outfitter/apps/commit/d410f7d8008a0d1dc16cde432ccf78960e3ffdff))
* **workshop:** restore the pre-review viewer layout ([#242](https://github.com/ai-outfitter/apps/issues/242)) ([572f956](https://github.com/ai-outfitter/apps/commit/572f956e1db326e9f5707b40ae006600025506fa))
* **workshop:** use the DOM type for reference figures ([#254](https://github.com/ai-outfitter/apps/issues/254)) ([1d0d4ee](https://github.com/ai-outfitter/apps/commit/1d0d4ee08b3f71d9b4f9e92b47d928379c906e1d))
* **workshop:** verify sliced geometry and scope print analysis ([0df3ae0](https://github.com/ai-outfitter/apps/commit/0df3ae0d007b05c36e8d6f65c77dcf1d7b99ea8b))


### Performance Improvements

* **workshop:** reuse CAD meshes and show a snapshot during rendering ([7505092](https://github.com/ai-outfitter/apps/commit/750509275887c3f3c4775766cfd2fd78c88daeeb))

## [0.1.4](https://github.com/ai-outfitter/apps/compare/workshop-v0.1.3...workshop-v0.1.4) (2026-11-17)


### Features

* **app-sdk:** queries run in the owning app's database, GraphQL follows Relay connections ([#215](https://github.com/ai-outfitter/apps/issues/215)) ([5be3e24](https://github.com/ai-outfitter/apps/commit/5be3e2491beef8848a00d6a92f37b3dc83fc3cee))
* share creative provenance across Marketing, Presentations and Workshop ([#191](https://github.com/ai-outfitter/apps/issues/191)) ([dfbd596](https://github.com/ai-outfitter/apps/commit/dfbd596b8b693f51a63bc992a19fe75d5d2b939b))
* **workshop:** add a bounded project-aware sidebar agent ([a0fa3f2](https://github.com/ai-outfitter/apps/commit/a0fa3f2ca5505dc28fc8e86886f49b20ec1e5b7d))
* **workshop:** build project-owned assemblies in container workspaces ([167019e](https://github.com/ai-outfitter/apps/commit/167019e9bffc370f2a14228e41722ad0c24f9d6c))
* **workshop:** inspect nested assemblies and saved power budgets ([#222](https://github.com/ai-outfitter/apps/issues/222)) ([c301f3a](https://github.com/ai-outfitter/apps/commit/c301f3a53abc7aef3b19f13f9b630e6b0e99e6e3))
* **workshop:** review imported KiCad PCB packages ([#223](https://github.com/ai-outfitter/apps/issues/223)) ([9724284](https://github.com/ai-outfitter/apps/commit/9724284a47b0ef9f16ac5ab96398ca8794f1c96c))
* **workshop:** screenshot the design workbench after each box design turn ([#130](https://github.com/ai-outfitter/apps/issues/130)) ([3490720](https://github.com/ai-outfitter/apps/commit/3490720e520d322bd12efdfd91d00eaef519ab31))
* **workshop:** serve saved previews and revision-bound visual evidence ([67d16c5](https://github.com/ai-outfitter/apps/commit/67d16c57dfb86657b09de81a4e01a3b2665b6ce1))
* **workshop:** simplify model navigation and mobile workspace views ([3e2cf76](https://github.com/ai-outfitter/apps/commit/3e2cf76e137ff252acf5d1036682f9a67349c088))
* **workshop:** start design work with a GraphQL mutation, with evals that drive it ([#189](https://github.com/ai-outfitter/apps/issues/189)) ([430be24](https://github.com/ai-outfitter/apps/commit/430be244acecc851ad1abbe2e9c48b90562f17ac))
* **workshop:** vision, assembly and case examples, case evals, and an app-owned design agent ([#57](https://github.com/ai-outfitter/apps/issues/57)) ([48b2791](https://github.com/ai-outfitter/apps/commit/48b2791df975fadf9e33e9afac6652434e5ca032))


### Bug Fixes

* **workshop:** capture the whole workbench page so the 3D view is not cut off ([#132](https://github.com/ai-outfitter/apps/issues/132)) ([ffecd1e](https://github.com/ai-outfitter/apps/commit/ffecd1e79ae773403743595d4e071c49b7d7d75d))
* **workshop:** grow the window to the workbench's height for box screenshots ([#135](https://github.com/ai-outfitter/apps/issues/135)) ([92a2467](https://github.com/ai-outfitter/apps/commit/92a2467f329060cbc1e2e3e4a37e9bc0c1c6d792))
* **workshop:** install into Wikis that already have the standard types ([#150](https://github.com/ai-outfitter/apps/issues/150)) ([20c9b2c](https://github.com/ai-outfitter/apps/commit/20c9b2cdbd26ee7efe23bfe0da6586883919cdf6))
* **workshop:** let the case evals reach a graded design on the Spark ([#108](https://github.com/ai-outfitter/apps/issues/108)) ([4306582](https://github.com/ai-outfitter/apps/commit/4306582fba368135ebb7a882a1a3f5ce4d082f3e))
* **workshop:** name the -X side in the power supply case prompt ([#115](https://github.com/ai-outfitter/apps/issues/115)) ([eac32f0](https://github.com/ai-outfitter/apps/commit/eac32f0f989f1581427fdc8ef0ad6d0009e48f69))
* **workshop:** scroll the 3D view into the window before the workbench screenshot ([#133](https://github.com/ai-outfitter/apps/issues/133)) ([b11efc7](https://github.com/ai-outfitter/apps/commit/b11efc7af216342adda851501b2c072fab270246))
* **workshop:** show a PCB preview when WebGL is unavailable ([#224](https://github.com/ai-outfitter/apps/issues/224)) ([850f4a4](https://github.com/ai-outfitter/apps/commit/850f4a4a3126b31a8314c25e88fcf101e24beba1))
* **workshop:** skip the screenshot wait when the workbench page does not load ([#139](https://github.com/ai-outfitter/apps/issues/139)) ([578c433](https://github.com/ai-outfitter/apps/commit/578c4331873b184c28e385abecef074eab9dd463))

## [0.1.3](https://github.com/ai-outfitter/apps/compare/workshop-v0.1.2...workshop-v0.1.3) (2026-11-09)


### Features

* **app-sdk:** Onto is only an app; graph contracts and client live in the SDK ([a887fe8](https://github.com/ai-outfitter/apps/commit/a887fe8d6d5faf16dba1cab61d36abf84bcfa746))

## [0.1.2](https://github.com/ai-outfitter/apps/compare/workshop-v0.1.1...workshop-v0.1.2) (2026-11-09)


### Features

* **app-sdk:** outfitterApp integration; apps drop their middleware and work under astro dev ([#58](https://github.com/ai-outfitter/apps/issues/58)) ([7bb923a](https://github.com/ai-outfitter/apps/commit/7bb923a96d13193cf82dda2c9792fc676aad32f6))
* **box:** score Workshop eval geometry against OpenSCAD reference parts ([#42](https://github.com/ai-outfitter/apps/issues/42)) ([91b34a9](https://github.com/ai-outfitter/apps/commit/91b34a935db354889431b26ee0812b9d7d20e6fb))
* **box:** sealed app boxes for the Software Foundry and Workshop ([#29](https://github.com/ai-outfitter/apps/issues/29)) ([2884844](https://github.com/ai-outfitter/apps/commit/28848447e4e1dc2ce36ff60cfed50a92714877dd))
* **onto:** extract Wiki Map as the public Onto app ([#45](https://github.com/ai-outfitter/apps/issues/45)) ([e5b064a](https://github.com/ai-outfitter/apps/commit/e5b064a5d021057819c42d0978413fbdc9633820))
* **onto:** per-type slugs, edge validity columns, forced endpoint types and batch anchors ([#52](https://github.com/ai-outfitter/apps/issues/52)) ([52b59f9](https://github.com/ai-outfitter/apps/commit/52b59f99abd9a313c8583cb512be4ca028914a9d))
* **onto:** slugs instead of UUIDs in agent documents ([#48](https://github.com/ai-outfitter/apps/issues/48)) ([21b4ae3](https://github.com/ai-outfitter/apps/commit/21b4ae376151dd4b4f42f2cad4800de26ae2012c))


### Bug Fixes

* resolve onto and connector-github from the workspace in apps ([#60](https://github.com/ai-outfitter/apps/issues/60)) ([fb2bb3c](https://github.com/ai-outfitter/apps/commit/fb2bb3cf1aa6928ddf46d9baf34afa6347a4e357))

## [0.1.1](https://github.com/ai-outfitter/apps/compare/workshop-v0.1.0...workshop-v0.1.1) (2026-11-06)


### Features

* **workshop:** add standalone official app ([#20](https://github.com/ai-outfitter/apps/issues/20)) ([b1150ff](https://github.com/ai-outfitter/apps/commit/b1150ff3588479653387d529e2abdcc9e95b6b3c))
