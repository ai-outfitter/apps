# Daily brief schedule

`forerunner-daily-brief` is a standard app workflow, separate from mail/calendar discovery. Its schedule trigger is 05:00 in the saved timezone. The platform `/automations/forerunner/forerunner-daily-brief` page and the published `DailyBriefSchedule`, `SetDailyBriefSchedule`, and `GenerateDailyBrief` documents expose it; platform Schedules/WorkflowRuns expose the same job. Reading a page never enables it. An editor explicitly saves it in their personal installation. Disabling stays disabled.

Each occurrence uses its scheduled date (not its retry date), reads the previous complete local day through DayReview, current private board priorities, and the previous saved brief reference, then upserts a bounded generated Wiki document in the same owner's Wiki. Identical content reuses the existing revision; changed content uses Wiki's revision check. Archived documents are not revived. Past dates reuse their saved document rather than mixing current priorities into history; missing historical snapshots cannot be backfilled by this job. The stable identity includes owner, installation, date and timezone.

Planning remains responsible for generating active-project reports and organization rollups. Forerunner consumes their saved exact-period revisions; it does not gain organization write authority or dispatch organization work. Its 05:00 default follows Planning's usual organization 03:00 and personal 04:00 schedules, but timing is not proof of readiness. Missing/late reports stay visible and a manual refresh can capture them later. Dependency-triggered reruns are future work.

Current sources: saved authorized org reports/project summaries, personal Planning report summary, board priorities/completion events, and previous brief revision. The previous brief is linked for continuity, not fed into a model; no LLM synthesis is claimed. Google Analytics, PostHog, Stripe, Databricks and raw calendar/mail ingestion are not implemented in this job. Measurement snapshots are specified in Planning's `docs/measurements.md`. Coverage and workflow outputs remain incomplete until these gaps are resolved; unknown is not zero. Existing discovery authorization is unchanged.

The root daily-conversation UI is still a separate local design preview. The generated document is readable in personal Wiki after a run from Automations → Forerunner daily brief → Run now. It does not overwrite the mock documents or automatically change canonical goals.

Validation: focused schedule/owner/timezone tests; real in-memory board database with fake Wiki checks unchanged retries and archived refusal; local app GraphQL schedule and generated-document readback. A manual generation is not evidence of a cron tick; deployed activation remains separate.

Timezone selection: new schedules require an explicit valid IANA timezone. The platform schedule editor detects the device timezone for first setup; a saved timezone stays authoritative until the user saves a change. The editor displays the device timezone alongside the saved value. This supports travel without letting a server timezone or a silent Chicago fallback change the user's calendar. Automatic account-wide timezone tracking is not implemented. The app schedule operation defaults to `0 5 * * *`; the platform editor allows a different saved cadence. Yesterday remains the previous complete local calendar day, including DST boundaries.

## Reading the saved brief (snapshot first)

`DailyHome` accepts `sections` so a page can read its parts independently: `digest`, `priorities`, `review` (yesterday's reports) and `history` (last week). Without `sections` it answers as before, in one combined result.

The `digest` section is the minimal current-brief read. It reads the saved schedule (for the time zone), resolves the owner's document Wiki once, looks up the pages for today and the six days before it in one request, and reads the documents it needs in a second request. It never reads Planning reports, organization memberships or the board. It returns:

- `brief`: today's saved document with `markdown`, `revision`, `href` (the exact Wiki revision), `date` and `savedAt`.
- `briefState`: `saved`, `missing` (no document, or it is archived) or `unavailable` (the Wiki or the document could not be read; this is not evidence that no brief exists).
- `latestBrief`: only when today's is missing, the newest earlier brief within the seven-day lookback, with its own `date`. A page shows it as that day's snapshot, never as today's.
- `previousBrief`: yesterday's reference (revision and link, no body), which keeps first-time setup detection without reading a second document body. The combined read still returns its body for older callers.

Other sections accept the `timezone` the digest returned and then skip the schedule read. Every answer includes `timings`: millisecond durations by step name (`schedule`, `wikiProvider`, `briefLookup`, `briefRead`, `priorities`, `review`, `history`). They hold no content, addresses or identifiers.

No section starts source collection, a model request, a workflow, a connector read or a schedule write.
