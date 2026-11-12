# Active project daily report foundation

The existing project-digest workflow now selects explicitly active, non-archived projects. Draft, backlog and completed projects no longer enter recurring runs. Manual digest generation remains available.

Each successful project read also creates a reviewable Wiki draft using the existing document contract. The unique page slug binds owner, Planning installation, project, America/Chicago calendar date and timezone. The existing 13:00 UTC trigger is unchanged. The first complete capture for a day is retained; repeated runs never overwrite authored or published content. Wiki is now an explicit Planning dependency.

Notes include structured changes, source scope, completeness, capture time, prior digest boundary, workflow run and digest references. A complete read with no changes still writes a note while preserving the old digest-history behavior. Failed reads fail the run; they cannot become no-change reports. Inference failures preserve complete structured changes with unavailable-narrative provenance. Retrying a run after Wiki failure reuses its saved Planning digest.

This foundation reads Planning records only. It does not read connectors, collect repository activity, publish documents, synthesize organization/personal reports, configure owner timezones, or replace existing digest history. Concurrent dispatch may still need retry after the Wiki slug uniqueness guard rejects a racing create. Daily periods identify the capture date, while source deltas retain the existing previous-digest boundary; they are not full midnight-to-midnight activity windows.

Validated by targeted Planning digest and Wiki document tests, including local midnight/DST, lifecycle filtering, no-change notes, failed sources, incomplete Wiki reads and retry recovery. Astro check is unavailable with this workstation's missing @astrojs/cloudflare dependency.
