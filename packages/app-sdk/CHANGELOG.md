# Changelog

## [0.1.4](https://github.com/ai-outfitter/apps/compare/app-sdk-v0.1.3...app-sdk-v0.1.4) (2026-11-09)


### Features

* **app-sdk:** outfitterApp integration; apps drop their middleware and work under astro dev ([#58](https://github.com/ai-outfitter/apps/issues/58)) ([7bb923a](https://github.com/ai-outfitter/apps/commit/7bb923a96d13193cf82dda2c9792fc676aad32f6))
* **box:** sealed app boxes for the Software Foundry and Workshop ([#29](https://github.com/ai-outfitter/apps/issues/29)) ([2884844](https://github.com/ai-outfitter/apps/commit/28848447e4e1dc2ce36ff60cfed50a92714877dd))
* **onto:** agents read and write records by address ([#54](https://github.com/ai-outfitter/apps/issues/54)) ([8b9f1c4](https://github.com/ai-outfitter/apps/commit/8b9f1c4737374deb36bd62d4a27b3cca02e429a9))
* **onto:** extract Wiki Map as the public Onto app ([#45](https://github.com/ai-outfitter/apps/issues/45)) ([e5b064a](https://github.com/ai-outfitter/apps/commit/e5b064a5d021057819c42d0978413fbdc9633820))
* **onto:** graph explorations agents and members change together ([#49](https://github.com/ai-outfitter/apps/issues/49)) ([f1c3424](https://github.com/ai-outfitter/apps/commit/f1c34248d61e4b9ff06082337400bcaf902017e2))
* **onto:** outside records by externalKey, accounts as OutfitterUser nodes ([#53](https://github.com/ai-outfitter/apps/issues/53)) ([d6a5c6a](https://github.com/ai-outfitter/apps/commit/d6a5c6acbcc3f725cbdbcbbd6132b05458c1ff55))
* **onto:** per-type slugs, edge validity columns, forced endpoint types and batch anchors ([#52](https://github.com/ai-outfitter/apps/issues/52)) ([52b59f9](https://github.com/ai-outfitter/apps/commit/52b59f99abd9a313c8583cb512be4ca028914a9d))
* **onto:** slugs instead of UUIDs in agent documents ([#48](https://github.com/ai-outfitter/apps/issues/48)) ([21b4ae3](https://github.com/ai-outfitter/apps/commit/21b4ae376151dd4b4f42f2cad4800de26ae2012c))


### Bug Fixes

* **app-sdk:** decide dev from the Astro command, not NODE_ENV ([#61](https://github.com/ai-outfitter/apps/issues/61)) ([55a8a60](https://github.com/ai-outfitter/apps/commit/55a8a60e08b931a52ecf2fbef9b62f2565a03f79))
* use canonical workflow run links ([#41](https://github.com/ai-outfitter/apps/issues/41)) ([8f5e0af](https://github.com/ai-outfitter/apps/commit/8f5e0af2d8377304dcf05c56fc64ee9c73465b41))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-outfitter/connector-core bumped from 0.1.1 to 0.1.2
    * @ai-outfitter/onto-contracts bumped from 0.1.0 to 0.1.1

## [0.1.3](https://github.com/ai-outfitter/apps/compare/app-sdk-v0.1.2...app-sdk-v0.1.3) (2026-11-06)


### Features

* **foundry:** add standalone official app ([#23](https://github.com/ai-outfitter/apps/issues/23)) ([ceb8ddc](https://github.com/ai-outfitter/apps/commit/ceb8ddc520ba34284147ade6b8ffc16fdfa9c060))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-outfitter/workflow-core bumped from 0.1.1 to 0.1.2

## [0.1.2](https://github.com/ai-outfitter/apps/compare/app-sdk-v0.1.1...app-sdk-v0.1.2) (2026-11-06)


### Features

* **workshop:** add standalone official app ([#20](https://github.com/ai-outfitter/apps/issues/20)) ([b1150ff](https://github.com/ai-outfitter/apps/commit/b1150ff3588479653387d529e2abdcc9e95b6b3c))

## [0.1.1](https://github.com/ai-outfitter/apps/compare/app-sdk-v0.1.0...app-sdk-v0.1.1) (2026-11-06)


### Features

* **sdk:** move public app SDK and portable builds into apps ([e952001](https://github.com/ai-outfitter/apps/commit/e95200193936f5ea69806e9103dea67e1f635390))
* **sdk:** publish app SDK source and portable builds in apps ([37176a4](https://github.com/ai-outfitter/apps/commit/37176a4510a9df18efcfaf21580333d143e4021a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-outfitter/connector-core bumped from 0.1.0 to 0.1.1
    * @ai-outfitter/workflow-core bumped from 0.1.0 to 0.1.1
