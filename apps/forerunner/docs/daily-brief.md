# Daily brief schedule

`forerunner-daily-brief` is a standard app workflow, separate from mail/calendar discovery. Its schedule trigger is 05:00 in the saved timezone. The platform `/automations/forerunner/forerunner-daily-brief` page and the published `DailyBriefSchedule`, `SetDailyBriefSchedule`, and `GenerateDailyBrief` documents expose it; platform Schedules/WorkflowRuns expose the same job. Trusted setup creates a default for a personal installation. Explicit saved schedules, including disabled ones, keep their time and time zone.

Each clock occurrence uses the local date of its claimed schedule slot through deferral and retry. It gathers saved evidence, asks the workflow host for one model answer over it, and upserts a generated Wiki document in the same owner's Wiki. Archived documents are not revived. Past dates reuse their saved document rather than mixing current priorities into history; missing historical snapshots cannot be backfilled by this job. The stable identity includes owner, installation, date and timezone. Scheduled and manual runs use the same code path.

Before generating a clock occurrence, Forerunner checks the current day’s enabled discovery schedules and their recorded analysis and suggestions slots. The brief can wait up to three hours from the original slot while discovery or an exact-period Onto report is pending. A failed slot stays visible even if the enclosing workflow completed. Once the wait expires, the brief records source gaps and uses what was saved. A manual refresh runs immediately and can incorporate late evidence.

Onto produces a previous-day Wiki report. Committed record revisions use the commit ledger timestamp. Open, awaiting-review and rejected batch updates are shown separately using their current states, so a batch updated yesterday does not establish a commit yesterday. The Wiki source reads only authorized revisions from the exact local period across native documents and the legacy ledger. It deduplicates cutover copies and excludes generated briefs and daily reports.

Planning remains responsible for its project and organization reports. Forerunner reads existing revisions under the member's authorization.

## How the brief is written

Evidence is saved records only, each given a short reference the model must cite:

- the saved role from the member's profile (`role1`), as their responsibilities;
- personal goals named in the saved personal Planning report's goal context (`g#`, with revision);
- open board priorities (`p#`) and yesterday's completions (`c#`);
- saved authorized organization reports and project summaries (`r#`) and the personal Planning overview (`o#`), linked to their exact saved revision;
- current discovery run receipts and recent open suggestions (`d#`);
- saved Onto reports (`app#`) and exact Wiki revisions (`wiki#`).

The job does not read mail, calendar or any connector. Google Analytics, PostHog, Stripe and Databricks are not collected. Every missing, stale, incomplete or unread source becomes a line under "Not known", written by code rather than by the model, so a missing report is never presented as a quiet day. Evidence sent to the model is cut per item and bounded to 24,000 bytes in total; records dropped for the bound are counted in "Not known".

The model answers in a fixed shape: an opening, up to eight highlights each marked fact or inference, up to five suggestions each with a reason and the goal it serves, and anything it could not support. Every statement must cite references that exist in the evidence, or the whole answer is rejected. Evidence text is passed as data with instructions never to follow it; model text is stripped of links and markup before it is saved, and source links come only from the saved records. The document ends with the source list, a link to the previous brief's exact revision and an evidence digest.

Provenance on the saved document records the owner, installation, date, timezone, run, capture time, coverage status, evidence digest, the cited source records and revisions, the gaps, and the previous brief. Coverage stays `incomplete` while any source is missing.

## Reruns, failures and concurrent runs

- Unchanged evidence: a rerun whose evidence digest matches the saved document returns that revision with outcome `unchanged`. No model request and no write happen.
- Changed evidence (a late report, a new priority): the run writes a new revision with Wiki's revision check and returns outcome `saved`.
- Failed or invalid answer (model error, timeout, a citation outside the evidence): nothing is written. The saved brief keeps its revision, and the run's output is `{date, status: "failed", reason}`, visible in WorkflowRuns and on the automation page, where it can be run again.
- Two runs at once: the second write fails the revision check (or the slug already exists), the run re-reads the document and returns the revision that stands with outcome `superseded`. One revision is written.
- A Wiki write failure with no newer revision fails the run without changing the saved brief.

Measurement snapshots are specified in Planning's `docs/measurements.md`. Existing discovery authorization is unchanged, and this job enables no discovery schedule.

Forerunner Today shows the saved revision, the latest run result and a refresh or retry action. The activity panel filters the previous completed day by date, authorized scope and source. Its controls and empty states remain visible when there is no matching activity.

## Default schedules

Trusted initialization of an installation uses the platform's insert-only schedule operation. Forerunner's personal default is 05:00, using an enabled discovery schedule's timezone when available and the app reporting default (America/Chicago) otherwise. Onto uses its 02:00 reporting default for personal installs and organization installs initialized by an authorized member editor. Service-driven organization setup without an authorized member leaves the producer schedule unset. Members can set an explicit schedule in Automations. Existing schedules keep their enabled state, cadence and timezone. The saved brief timezone defines yesterday, including 23- and 25-hour DST days.

## Reading the saved brief (snapshot first)

`DailyHome` accepts `sections` so a page can read its parts independently: `digest`, `priorities`, `review` (yesterday's reports) and `history` (last week). Without `sections` it answers as before, in one combined result.

The `digest` section is the minimal current-brief read. It reads the saved schedule (for the time zone), resolves the owner's document Wiki once, looks up the pages for today and the six days before it in one request, and reads the documents it needs in a second request. It never reads Planning reports, organization memberships or the board. It reads the latest run and its completed brief slot. It returns:

- `brief`: today's saved document with `markdown`, `revision`, `href` (the exact Wiki revision), `date` and `savedAt`.
- `briefRun`: the latest run outcome, including a failed brief slot and its reason.
- `briefState`: `saved`, `missing` (no document, or it is archived) or `unavailable` (the Wiki or the document could not be read; this is not evidence that no brief exists).
- `latestBrief`: only when today's is missing, the newest earlier brief within the seven-day lookback, with its own `date`. A page shows it as that day's snapshot, never as today's.
- `previousBrief`: yesterday's reference (revision and link, no body), which keeps first-time setup detection without reading a second document body. The combined read still returns its body for older callers.

The digest reads today's and yesterday's briefs with one Wiki request: each dated page with its document. The Wiki is named by its package (`wiki-map`) and the platform finds the member's installation, so nothing is listed, described or looked up first. Only a day with neither brief makes a second request for the five days before.

The `review` and `history` sections show the member's saved personal overview as the snapshot of the day. Planning captures each organization's report into that overview when it writes it, in the member's priority order, so the page takes the organizations from it and reads no organization at page load. Each row links to the pinned Wiki revision of that organization's report.

Only on a day with no readable personal overview does the page read each organization's saved report from Planning's published `DailyReports` document (`platform.document` with `app: "planning"` and that organization as the only scope), as the member. One read per organization keeps a failing organization from hiding the others. In production on 2026-11-14 that path took about 10 seconds for five organizations.

Other sections accept the `timezone` the digest returned and then skip the schedule read. Every answer includes `timings`: millisecond durations by step name (`schedule`, `briefRun`, `briefRead`, `priorities`, `review`, `history`). They hold no content, addresses or identifiers.

No section starts source collection, a model request, a workflow, a connector read or a schedule write.
