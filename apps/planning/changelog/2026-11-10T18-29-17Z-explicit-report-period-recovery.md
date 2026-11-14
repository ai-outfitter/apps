# Recover daily and weekly reports for explicit past periods

The existing `GenerateDailyReports` mutation accepts optional `date` (YYYY-MM-DD) alongside `timezone`. It carries that date in the registered task's durable inputs, so a new recovery task after midnight targets the same Wiki report identities and revises only changed generated sections. Explicit recovery does not write or advance the ordinary rolling-digest snapshots/cursor. Current/future local dates are refused before dispatch and again at task execution. Omitting the date keeps the previous local-day behavior.

The existing `GenerateProductReport` mutation similarly accepts optional `at` (a calendar date within the desired week). The registered task derives the selected week through the existing pure weekly-period helper and uses that same week for captured daily evidence and revision-guarded report updates. Existing sealed reports remain immutable. Default tasks use their persisted creation time, and scheduled weekly dispatch uses its occurrence time, so delayed execution does not drift across periods.

No schedule is enabled or changed. Recovery does not invent unavailable history: current Planning rows still carry the existing limited historical coverage, and missing daily dependencies keep weekly evidence incomplete. New task IDs provide explicit recovery from terminal failures while existing report IDs and immutable revisions preserve prior attempts.

Validated with daily recovery across midnight/new task IDs, current/future day refusal, historical weekly evidence/update selection, sealed-week refusal, registered workflow checks and the Planning unit suite.
