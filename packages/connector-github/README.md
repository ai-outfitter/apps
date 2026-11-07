# @ai-outfitter/connector-github

Read GitHub repository activity for an explicit branch and half-open reporting
period. The package translates GitHub API responses into bounded captures; the
caller injects an already authorized read transport:

```ts
import { captureGithubActivity } from "@ai-outfitter/connector-github";
const capture = await captureGithubActivity(readGithubPath, {
  repository: "team/repo",
  branch: "main",
  start: "2026-01-01T00:00:00Z",
  end: "2026-02-01T00:00:00Z",
});
```

`readGithubPath(path)` returns the parsed API response. This package never reads
credentials, opens network connections, dispatches platform calls or performs
writes. An optional third argument `{ connectionId }` records an opaque source
identifier as provenance; it grants no authority.

Pull requests use `merged_at` and the selected base branch; commits use committer
date. Pull requests are scanned across all states in ascending creation order
(`state=all&sort=created&direction=asc`), using the supported
[GitHub list pull requests parameters](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests).
This avoids page membership moving when a PR is reopened or its update time
changes; unmerged rows are read but do not count as merged activity. Results
deduplicate stable IDs and include the observed branch head and period semantics.
Pagination is capped at ten pages of 100 per collection. Scanning all creation
history makes this cap more likely in larger repositories, even for a short
reporting period; hitting it correctly leaves the capture incomplete.
Failures, malformed responses, cross-page overlap, caps and branch-head changes
remain explicit incomplete captures. Observations do not claim an atomic
snapshot across GitHub APIs.

Onto's adapter retains the `github-report` binding, validates its connection ID,
and re-enters the authorized host on every read. Scheduled access continues to
fail closed when its host cannot authorize the connection. This package does
not register a graph provider or a platform connector; those integrations remain
separate work. Export/write connector behavior remains with existing callers.
