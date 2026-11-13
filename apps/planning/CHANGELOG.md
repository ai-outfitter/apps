# Changelog

## Unreleased

- Read personal GitHub pull requests using the account connection owner and real connection ID through the shared SDK helper.

- Keep project detail available when bounded Wiki context has no release/evidence types, while retaining supported evidence paths and project scope checks.

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
