# Research reports

`forerunner-research-report` saves a dated report to the member's personal Wiki each morning from public web searches. It is a standard app workflow, separate from discovery and the daily brief, and only runs on a personal installation.

## What a member saves

`SetResearchReportSchedule` takes `enabled`, `timezone`, `hour` (default 7) and up to three `reports`. Saving replaces the earlier reports, because the platform keeps one schedule per workflow.

| Field | Meaning |
| --- | --- |
| `slug` | Stable name used in the page address |
| `title` | The document title, followed by the date |
| `subject` | Optional sentence on who the report is for, which the writer uses to judge relevance |
| `location` | The place every search is about, such as a city and region |
| `topics` | One to six topics; each is one search and one section |

`ResearchReportSchedule` reads what is saved. `GenerateResearchReports` runs the saved reports now. Platform Schedules and WorkflowRuns show the same schedule and runs.

## What a run does

1. Runs one `web.search` per topic (`<topic> <location>`, six results, published in the last month). A failed search is counted, not fatal.
2. Sends the report and the deduplicated pages to `inference.generate` as data. The instructions ask for upcoming or still open items in or near the place, each with the source's address.
3. Drops any item whose address is not one a search returned, and any repeat, so the report never links to a page the model made up.
4. Saves the Markdown as the generated body of `forerunner-research-<slug>-<date>-<stable id>` in the owner's Wiki. Identical content reuses the revision; an archived document is not revived.
5. Collects one receipt per report on the run: `saved`, `unchanged`, `empty` (searches answered, nothing relevant) or `failed` with a reason.

When every search fails, for example on a platform without a search credential, nothing is saved, so a missing report is never mistaken for an empty day.

## Limits

- Items are search extracts summarized by a model. Dates and deadlines are quoted as the source states them and are not verified; the document says so.
- Only the query (topic and place) leaves the platform. Do not put private details in a topic or place.
- The report is a Wiki document. It does not create graph records or link to an organization node yet.
- There is no page for editing reports yet; use the documents above.
