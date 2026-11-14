# Changelog

## Unreleased

- Route personal GitHub pull request reads by account ownership, retaining the actual connection ID instead of requiring a synthetic ID.

## [0.1.5](https://github.com/ai-outfitter/apps/compare/app-sdk-v0.1.4...app-sdk-v0.1.5) (2026-11-14)


### Features

* **app-sdk:** Onto is only an app; graph contracts and client live in the SDK ([a887fe8](https://github.com/ai-outfitter/apps/commit/a887fe8d6d5faf16dba1cab61d36abf84bcfa746))
* **app-sdk:** presigned direct uploads; Foundry evidence uses them ([#153](https://github.com/ai-outfitter/apps/issues/153)) ([784fe1d](https://github.com/ai-outfitter/apps/commit/784fe1d891c777aeb241c8c4b66732789d12ed6d))
* deliver personal portfolio and daily reports ([c1a2c03](https://github.com/ai-outfitter/apps/commit/c1a2c03de78105602cc6a17e9aced640f16b33a1))
* **forerunner:** catch up with webapp's Forerunner and publish it from app CI ([#129](https://github.com/ai-outfitter/apps/issues/129)) ([f1d2be8](https://github.com/ai-outfitter/apps/commit/f1d2be8fe5590885a15d7a6a17d3b9dfa37764e1))
* **forerunner:** daily research reports from web search, saved to the Wiki ([#185](https://github.com/ai-outfitter/apps/issues/185)) ([fd8df68](https://github.com/ai-outfitter/apps/commit/fd8df68801476040f4ebca03744f878af02b651b))
* move Planning and Forerunner into the apps repo ([#80](https://github.com/ai-outfitter/apps/issues/80)) ([144beef](https://github.com/ai-outfitter/apps/commit/144beef23843642cd506d98ad86e00bb3eb3078a))
* move Wiki documents and pages into Outfitter Apps ([7135465](https://github.com/ai-outfitter/apps/commit/71354656e1837c7383fbd8333830f6f2c14d7e98))
* **onto:** improve graph review and batch iteration ([009b7e0](https://github.com/ai-outfitter/apps/commit/009b7e072cd96c24ba95c51264938bcc1b5f2242))
* **onto:** include batch review URLs ([#151](https://github.com/ai-outfitter/apps/issues/151)) ([e378e39](https://github.com/ai-outfitter/apps/commit/e378e39c197c274799953d83aee9565d29295236))
* **onto:** let the share's organization read it from its own organization ([#113](https://github.com/ai-outfitter/apps/issues/113)) ([4d75e59](https://github.com/ai-outfitter/apps/commit/4d75e59c79a485910aaac95c70b937d630e74d35))
* **planning:** design partners file feature and bug requests from their own organization ([#168](https://github.com/ai-outfitter/apps/issues/168)) ([68c1923](https://github.com/ai-outfitter/apps/commit/68c1923d3b6fba463469fcd3976ebcba3518b171))
* **software-foundry:** owners turn a repository on from Foundry over MCP ([#140](https://github.com/ai-outfitter/apps/issues/140)) ([6c5dffa](https://github.com/ai-outfitter/apps/commit/6c5dffa05bb5a35ed7c49003ce5ce639a035ff9e))
* **software-foundry:** repository jobs start issue-to-merge for the issues they file ([#171](https://github.com/ai-outfitter/apps/issues/171)) ([28bb413](https://github.com/ai-outfitter/apps/commit/28bb41319c6c1eb840e41b8dea3ba6e1bf13686b))
* **workshop:** vision, assembly and case examples, case evals, and an app-owned design agent ([#57](https://github.com/ai-outfitter/apps/issues/57)) ([48b2791](https://github.com/ai-outfitter/apps/commit/48b2791df975fadf9e33e9afac6652434e5ca032))


### Bug Fixes

* **software-foundry:** executor bindings survive package upgrades ([#97](https://github.com/ai-outfitter/apps/issues/97)) ([88ca9b5](https://github.com/ai-outfitter/apps/commit/88ca9b5775e96c3ca9f125c72efc52961f539e97))
* **workshop:** install into Wikis that already have the standard types ([#150](https://github.com/ai-outfitter/apps/issues/150)) ([20c9b2c](https://github.com/ai-outfitter/apps/commit/20c9b2cdbd26ee7efe23bfe0da6586883919cdf6))


### Performance Improvements

* **app-sdk:** share first-primary D1 sessions per request ([#180](https://github.com/ai-outfitter/apps/issues/180)) ([a85a8f5](https://github.com/ai-outfitter/apps/commit/a85a8f5574f927308840d5911e0f2f79defe2587))
* **forerunner:** faster digest, and reports read from Planning's DailyReports ([#193](https://github.com/ai-outfitter/apps/issues/193)) ([1888866](https://github.com/ai-outfitter/apps/commit/188886656c6868751b508c993605e63062b570ca))

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
