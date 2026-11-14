# Changelog

## [0.3.6](https://github.com/ai-outfitter/apps/compare/software-foundry-v0.3.5...software-foundry-v0.3.6) (2026-11-14)


### Features

* **app-sdk:** presigned direct uploads; Foundry evidence uses them ([#153](https://github.com/ai-outfitter/apps/issues/153)) ([784fe1d](https://github.com/ai-outfitter/apps/commit/784fe1d891c777aeb241c8c4b66732789d12ed6d))
* **software-foundry:** each role gets only its own guidance ([#148](https://github.com/ai-outfitter/apps/issues/148)) ([9e96499](https://github.com/ai-outfitter/apps/commit/9e96499cb6ad29ad0e3bd68ec329ccdbb7c89b00))
* **software-foundry:** gate ai-outfitter/apps on its CI and add configure-repository ([#138](https://github.com/ai-outfitter/apps/issues/138)) ([7511a11](https://github.com/ai-outfitter/apps/commit/7511a1102e4dedcd7574157627244a1d94e2fae9))
* **software-foundry:** job runs retry stopped fixes and close ones that keep failing ([#192](https://github.com/ai-outfitter/apps/issues/192)) ([ed7dfa3](https://github.com/ai-outfitter/apps/commit/ed7dfa3f6e3fbe53ec6686c9a4484ed9bde86b20))
* **software-foundry:** owners turn a repository on from Foundry over MCP ([#140](https://github.com/ai-outfitter/apps/issues/140)) ([6c5dffa](https://github.com/ai-outfitter/apps/commit/6c5dffa05bb5a35ed7c49003ce5ce639a035ff9e))
* **software-foundry:** repository jobs start issue-to-merge for the issues they file ([#171](https://github.com/ai-outfitter/apps/issues/171)) ([28bb413](https://github.com/ai-outfitter/apps/commit/28bb41319c6c1eb840e41b8dea3ba6e1bf13686b))
* **software-foundry:** RequestChanges resume restarts a stopped request run ([#144](https://github.com/ai-outfitter/apps/issues/144)) ([bfc8a64](https://github.com/ai-outfitter/apps/commit/bfc8a648e7fac3f8b2dad60567876b7013c95b81))
* **software-foundry:** UI review job that files remediation issues ([#159](https://github.com/ai-outfitter/apps/issues/159)) ([162bef8](https://github.com/ai-outfitter/apps/commit/162bef8b6c9959a9bc37c6377a405a2249600bbf))


### Bug Fixes

* **software-foundry:** a later comment-only review keeps the approval current ([#123](https://github.com/ai-outfitter/apps/issues/123)) ([c6a2ccb](https://github.com/ai-outfitter/apps/commit/c6a2ccbf940ae434b0dde67dba21866a3e02739a))
* **software-foundry:** another agent's same-head approval keeps Foundry's approval current ([#126](https://github.com/ai-outfitter/apps/issues/126)) ([0588a5c](https://github.com/ai-outfitter/apps/commit/0588a5ccc2ea577bccf9121ec5e53aec77a46e44))
* **software-foundry:** capture UI before shots in the same checkout ([#181](https://github.com/ai-outfitter/apps/issues/181)) ([d91d239](https://github.com/ai-outfitter/apps/commit/d91d23945d9b3470dcd9017e4b6ceabe42413dc4))
* **software-foundry:** job retries find agent-filed issues; one combined dependency issue ([#195](https://github.com/ai-outfitter/apps/issues/195)) ([656ee79](https://github.com/ai-outfitter/apps/commit/656ee79948aa9e9a684b3ff21dc9255773c092ab))
* **software-foundry:** repository jobs file few issues that Foundry fixes and merges ([#167](https://github.com/ai-outfitter/apps/issues/167)) ([7680e92](https://github.com/ai-outfitter/apps/commit/7680e92e8c06ff15d7aeebb9186da62f387e81b2))
* **software-foundry:** repository jobs get gh by using the file-issues role ([#165](https://github.com/ai-outfitter/apps/issues/165)) ([8aa424c](https://github.com/ai-outfitter/apps/commit/8aa424c58d5167a91afb39743327f12485c1e6c9))
* **software-foundry:** repository jobs run under approved workspace agents ([#163](https://github.com/ai-outfitter/apps/issues/163)) ([a4e396e](https://github.com/ai-outfitter/apps/commit/a4e396e7cfd13aba4267bc4431b0a29df5227487))
* **software-foundry:** RequestChanges description names the work-request fields ([#121](https://github.com/ai-outfitter/apps/issues/121)) ([2982ea8](https://github.com/ai-outfitter/apps/commit/2982ea8514e72c4ec8d602da891bafbb000053b7))
* **software-foundry:** serve stored files at any key depth ([#161](https://github.com/ai-outfitter/apps/issues/161)) ([e8d58b5](https://github.com/ai-outfitter/apps/commit/e8d58b51106f864d2f2f07edf1de99fe5686069f))
* **software-foundry:** start scheduled repository jobs ([#160](https://github.com/ai-outfitter/apps/issues/160)) ([568fa33](https://github.com/ai-outfitter/apps/commit/568fa336d6a1009183bdbf27a77e8cb926c6fb60))
* **software-foundry:** UI fix issues carry a short before/after capture recipe ([#178](https://github.com/ai-outfitter/apps/issues/178)) ([61b554d](https://github.com/ai-outfitter/apps/commit/61b554d254d78e4ad30f84ccf215045779beb36a))
* **software-foundry:** UI review screenshots one app per run ([#170](https://github.com/ai-outfitter/apps/issues/170)) ([25365a4](https://github.com/ai-outfitter/apps/commit/25365a49369fa4a95c10de6318ed4f3bcaa83c22))
* **software-foundry:** UI review uses demo data and every app ([#164](https://github.com/ai-outfitter/apps/issues/164)) ([95c18d2](https://github.com/ai-outfitter/apps/commit/95c18d2f99902c10e19463fe3bb25bf27acf4cf7))
* **software-foundry:** use hairline workflow sections ([#183](https://github.com/ai-outfitter/apps/issues/183)) ([3dc1ee4](https://github.com/ai-outfitter/apps/commit/3dc1ee4e1505cbf5293bded54aee892cae81baae))

## [0.3.5](https://github.com/ai-outfitter/apps/compare/software-foundry-v0.3.4...software-foundry-v0.3.5) (2026-11-10)


### Features

* **software-foundry:** RequestChanges is the one front door for feature and bug requests ([#119](https://github.com/ai-outfitter/apps/issues/119)) ([82ee1d9](https://github.com/ai-outfitter/apps/commit/82ee1d988291ec0bdf187d4ca111c9bd57b5f8b8))

## [0.3.4](https://github.com/ai-outfitter/apps/compare/software-foundry-v0.3.3...software-foundry-v0.3.4) (2026-11-09)


### Bug Fixes

* **software-foundry:** executor bindings survive package upgrades ([#97](https://github.com/ai-outfitter/apps/issues/97)) ([88ca9b5](https://github.com/ai-outfitter/apps/commit/88ca9b5775e96c3ca9f125c72efc52961f539e97))

## [0.3.3](https://github.com/ai-outfitter/apps/compare/software-foundry-v0.3.2...software-foundry-v0.3.3) (2026-11-09)


### Features

* **app-sdk:** Onto is only an app; graph contracts and client live in the SDK ([a887fe8](https://github.com/ai-outfitter/apps/commit/a887fe8d6d5faf16dba1cab61d36abf84bcfa746))

## [0.3.2](https://github.com/ai-outfitter/apps/compare/software-foundry-v0.3.1...software-foundry-v0.3.2) (2026-11-09)


### Features

* **app-sdk:** outfitterApp integration; apps drop their middleware and work under astro dev ([#58](https://github.com/ai-outfitter/apps/issues/58)) ([7bb923a](https://github.com/ai-outfitter/apps/commit/7bb923a96d13193cf82dda2c9792fc676aad32f6))
* **box:** sealed app boxes for the Software Foundry and Workshop ([#29](https://github.com/ai-outfitter/apps/issues/29)) ([2884844](https://github.com/ai-outfitter/apps/commit/28848447e4e1dc2ce36ff60cfed50a92714877dd))
* **foundry:** work on an organization's Forgejo connection ([#40](https://github.com/ai-outfitter/apps/issues/40)) ([ee79ae8](https://github.com/ai-outfitter/apps/commit/ee79ae839e7cbd1c419439731bec5d592078590d))
* **onto:** extract Wiki Map as the public Onto app ([#45](https://github.com/ai-outfitter/apps/issues/45)) ([e5b064a](https://github.com/ai-outfitter/apps/commit/e5b064a5d021057819c42d0978413fbdc9633820))
* **onto:** per-type slugs, edge validity columns, forced endpoint types and batch anchors ([#52](https://github.com/ai-outfitter/apps/issues/52)) ([52b59f9](https://github.com/ai-outfitter/apps/commit/52b59f99abd9a313c8583cb512be4ca028914a9d))
* **onto:** slugs instead of UUIDs in agent documents ([#48](https://github.com/ai-outfitter/apps/issues/48)) ([21b4ae3](https://github.com/ai-outfitter/apps/commit/21b4ae376151dd4b4f42f2cad4800de26ae2012c))


### Bug Fixes

* **foundry:** show box screenshots in Forgejo PRs and add a new-app eval ([#56](https://github.com/ai-outfitter/apps/issues/56)) ([31146bf](https://github.com/ai-outfitter/apps/commit/31146bfa77ce9a6781ec32cc9829d81912c8770d))
* resolve onto and connector-github from the workspace in apps ([#60](https://github.com/ai-outfitter/apps/issues/60)) ([fb2bb3c](https://github.com/ai-outfitter/apps/commit/fb2bb3cf1aa6928ddf46d9baf34afa6347a4e357))
* use canonical workflow run links ([#41](https://github.com/ai-outfitter/apps/issues/41)) ([8f5e0af](https://github.com/ai-outfitter/apps/commit/8f5e0af2d8377304dcf05c56fc64ee9c73465b41))

## [0.3.1](https://github.com/ai-outfitter/apps/compare/software-foundry-v0.3.0...software-foundry-v0.3.1) (2026-11-06)


### Features

* **foundry:** add standalone official app ([#23](https://github.com/ai-outfitter/apps/issues/23)) ([ceb8ddc](https://github.com/ai-outfitter/apps/commit/ceb8ddc520ba34284147ade6b8ffc16fdfa9c060))
