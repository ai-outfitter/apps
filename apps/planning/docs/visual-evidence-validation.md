# Visual evidence review validation

Implemented on `feat/visual-evidence-review`, based on apps main `4e04d1a`. The review UI displays ordered screenshots and video, optional exact-version comparisons, source details, gallery navigation and downloads. The same projection is exposed through MCP. Nothing in this change approves a release or converts generated concept footage into engineering evidence.

## Checks

- Planning unit coverage includes schema validation, stale references, scoped reads, idempotent staging, multiple captures in one batch, and decided-record preview refusal.
- Browser coverage exercises desktop and mobile, real MP4 playback, SHA-256-matching downloads, missing images, empty captures, exact and unavailable earlier revisions, legacy walkthroughs, and unauthorized requests.
- Each evidence navigation performs one bounded graph query. Five local worker navigations measured 173–282 ms at desktop width and 144–271 ms at mobile width. These include fixture graph responses and are not production latency measurements.
- Existing Marketing footage and screenshots from the November 16 local capture were used as viewer inputs. Their original capture commit, modified-working-tree flag and limitations were retained. They were not relabeled as captures of current main.

## Data and rollout

The existing Marketing and Planning bundle proposals were converted to the new schema without replacing their media, IDs or capture provenance. During validation, Onto committed the Planning proposal through its steward; Marketing remained awaiting review. Application deployment is separate from graph application. The new reader must be deployed before assuming the new viewer is available at production links.

The migration helper writes a validated JSON bundle from an existing manifest plus explicit step/media mappings. It neither uploads files nor applies graph changes. The canonical media remains in the producing app's storage.

## Performance boundaries

Evidence reads are bounded to a project's review neighborhood, with no whole-graph fallback or repeated project-context load. Project-card capture summaries load only when visible, with three concurrent requests at most. The project directory and product revision loader retain their existing broader data contracts; this change does not introduce a global materialized index or claim to have eliminated every slow path. Evidence index pagination is over a bounded selection, not unlimited server-side history.

Full-host local screenshots and timings are retained outside the repository under `.local-data/app-demos/2026-11-17-visual-evidence/`. They use the shared private seed snapshots and are not public fixtures.

## Full local host results

Current-main webapp `ebcc73d9` with the changed Planning app and the retained private seed snapshots:

| Page | First request | Subsequent four requests | Result |
| --- | --- | --- | --- |
| Projects | 5.36 s | 1.55–1.64 s | 200 |
| Project detail | 0.85 s | 0.97–1.08 s | 200 |
| Evidence | 0.68 s | 0.36–0.41 s | 200 |
| Project digest | 0.22 s | 0.25–0.33 s | 200 |

Measurements run to DOM content loaded, not media completion. The first projects request includes development-runtime initialization. The directory originally returned 503 because its Viewer response exceeded the platform's 64 KiB budget. Removing unused story/customer summaries and reducing page size to 20 fixes that failure; it does not make directory loading instantaneous. Saved digests are a separate, cheaper read and are not substituted for capture evidence.

The retained local snapshot predates the newly committed Planning evidence bundle, so its full-host evidence screenshot honestly shows no captured media. Populated media/playback screenshots come from the isolated worker using the actual November 16 captured image and MP4, not fabricated current-production data.

A subsequent repeat capture saw one intermittent directory 503 among five navigations; the local host also logged SQLite lock errors during this session. The captured directory recovered on the next navigation. This development-runtime instability is not claimed as resolved by the query-size fix.
