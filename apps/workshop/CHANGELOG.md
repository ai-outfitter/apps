# Changelog

## [0.1.4](https://github.com/ai-outfitter/apps/compare/workshop-v0.1.3...workshop-v0.1.4) (2026-11-14)


### Features

* **workshop:** add a bounded project-aware sidebar agent ([a0fa3f2](https://github.com/ai-outfitter/apps/commit/a0fa3f2ca5505dc28fc8e86886f49b20ec1e5b7d))
* **workshop:** build project-owned assemblies in container workspaces ([167019e](https://github.com/ai-outfitter/apps/commit/167019e9bffc370f2a14228e41722ad0c24f9d6c))
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
