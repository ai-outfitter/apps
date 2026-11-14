# Daily brief schedule

`forerunner-daily-brief` is a standard app workflow, separate from mail/calendar discovery. Its schedule trigger is 05:00 in the saved timezone. The platform `/automations/forerunner/forerunner-daily-brief` page and the published `DailyBriefSchedule`, `SetDailyBriefSchedule`, and `GenerateDailyBrief` documents expose it; platform Schedules/WorkflowRuns expose the same job. Reading a page never enables it. An editor explicitly saves it in their personal installation. Disabling stays disabled.

Each occurrence uses its scheduled date (not its retry date). It gathers saved evidence, asks the workflow host for one model answer over it, and upserts a generated Wiki document in the same owner's Wiki. Archived documents are not revived. Past dates reuse their saved document rather than mixing current priorities into history; missing historical snapshots cannot be backfilled by this job. The stable identity includes owner, installation, date and timezone. Scheduled and manual runs use the same code path.

Planning remains responsible for generating active-project reports and organization rollups. Forerunner consumes their saved exact-period revisions; it does not gain organization write authority or dispatch organization work. Its 05:00 default follows Planning's usual organization 03:00 and personal 04:00 schedules, but timing is not proof of readiness. Missing/late reports stay visible and a manual refresh can capture them later. Dependency-triggered reruns are future work.

## How the brief is written

Evidence is saved records only, each given a short reference the model must cite:

- the saved role from the member's profile (`role1`), as their responsibilities;
- personal goals named in the saved personal Planning report's goal context (`g#`, with revision);
- open board priorities (`p#`) and yesterday's completions (`c#`);
- saved authorized organization reports and project summaries (`r#`) and the personal Planning overview (`o#`), linked to their exact saved revision;
- open suggestions saved by the last daily discovery run (`d#`), only when that run is under 36 hours old.

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

The root daily-conversation UI is still a separate local design preview. The generated document is readable in personal Wiki after a run from Automations → Forerunner daily brief → Run now. It does not overwrite the mock documents or automatically change canonical goals.

Validation: unit tests with a real in-memory board database, a fake Wiki and a stand-in model cover schedule/owner/timezone, evidence and gaps, the byte bound, citation rejection, injected instructions and links in source text, unchanged reruns, archived refusal, failure keeping the prior revision, concurrent runs and owner isolation. The stand-in model does not show how well a real model weighs role and goals; that needs a run against a real account. A manual generation is not evidence of a cron tick; deployed activation remains separate.

Timezone selection: new schedules require an explicit valid IANA timezone. The platform schedule editor detects the device timezone for first setup; a saved timezone stays authoritative until the user saves a change. The editor displays the device timezone alongside the saved value. This supports travel without letting a server timezone or a silent Chicago fallback change the user's calendar. Automatic account-wide timezone tracking is not implemented. The app schedule operation defaults to `0 5 * * *`; the platform editor allows a different saved cadence. Yesterday remains the previous complete local calendar day, including DST boundaries.

## Default schedule

The daily brief is on by default for a personal installation. `SetDailyBriefSchedule` with `ifUnset: true` (and `enabled: true`) saves the standard 05:00 schedule in the given time zone only when no `forerunner-daily-brief` schedule exists at all. Any saved schedule is the member's choice and is returned untouched: one that was turned off stays off, and a custom time or time zone is kept. Repeating the call saves nothing.

It is an explicit request by the member, never part of a read or a page GET. Two callers send it with the device's time zone: the platform's Today page, and Forerunner's own `POST /api/apps/forerunner/schedule`, which Settings and Sources already call to default daily discovery. Without a time zone nothing is created, so the brief never runs on a guessed day; there is no UTC fallback for it. The default attaches no connection, enables no discovery schedule and is refused for organization installations and readers.

Existing members without a schedule get it on their next visit to Today, Settings or Sources. A member who opens none of them gets no schedule. The time zone is corrected on the automation page, and the saved zone then stays authoritative. Creating the schedule at install time is not done: the initializer can run as the platform with no member device, so it has no time zone to use and would save the schedule under the platform's identity.

## Reading the saved brief (snapshot first)

`DailyHome` accepts `sections` so a page can read its parts independently: `digest`, `priorities`, `review` (yesterday's reports) and `history` (last week). Without `sections` it answers as before, in one combined result.

The `digest` section is the minimal current-brief read. It reads the saved schedule (for the time zone), resolves the owner's document Wiki once, looks up the pages for today and the six days before it in one request, and reads the documents it needs in a second request. It never reads Planning reports, organization memberships or the board. It returns:

- `brief`: today's saved document with `markdown`, `revision`, `href` (the exact Wiki revision), `date` and `savedAt`.
- `briefState`: `saved`, `missing` (no document, or it is archived) or `unavailable` (the Wiki or the document could not be read; this is not evidence that no brief exists).
- `latestBrief`: only when today's is missing, the newest earlier brief within the seven-day lookback, with its own `date`. A page shows it as that day's snapshot, never as today's.
- `previousBrief`: yesterday's reference (revision and link, no body), which keeps first-time setup detection without reading a second document body. The combined read still returns its body for older callers.

The digest does not wait on the schedule to begin: the Wiki is resolved while the schedule loads. Discovery names the Wiki package (`wiki-map`), so the platform lists and describes that one installation instead of every installed app; the `outfitter.wiki-documents` contract still decides, and a Wiki under another package name is found by asking every provider as before.

The `review` and `history` sections read every organization's saved report for a day in one platform `Viewer` read (memberships and each organization's `dailyReports` together), so the member is authorized once per day instead of once per organization. When the platform refuses that combined answer (too large, one organization failing, or the report field not offered), each organization is read on its own, so one failing organization is reported as unavailable without hiding the others.

Other sections accept the `timezone` the digest returned and then skip the schedule read. Every answer includes `timings`: millisecond durations by step name (`schedule`, `wikiProvider`, `briefLookup`, `briefRead`, `priorities`, `review`, `history`). They hold no content, addresses or identifiers.

No section starts source collection, a model request, a workflow, a connector read or a schedule write.
