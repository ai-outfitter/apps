# Read the saved brief without waiting on reports

`DailyHome` now takes `sections` (`digest`, `priorities`, `review`, `history`). The `digest` section returns today's saved brief, its exact Wiki revision, `savedAt` and an explicit `briefState` (`saved`, `missing`, `unavailable`) after one schedule read, one Wiki provider resolution and two Wiki requests. It no longer shares a response with cross-organization reports. When today's brief is missing it also returns `latestBrief`, the newest earlier brief from the last seven days, dated as its own day.

Yesterday's brief is read as a reference (revision and link) rather than a second full document, and the Wiki provider is resolved once per read instead of once per brief. Answers carry millisecond `timings` per step with no content or identifiers. The combined read without `sections` keeps its previous shape for callers that have not moved yet.

Reads still start no generation, workflow, connector read or schedule write. Validation is unit tests against a fake Wiki host; no production timing is claimed here. See [daily brief](../docs/daily-brief.md).
