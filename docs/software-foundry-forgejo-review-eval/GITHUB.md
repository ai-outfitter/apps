# Installed GitHub issue review eval

Run these cases with the host and operational package from the same release candidate as the Forgejo cases.

```sh
./run.sh "$HOST" github-happy "$OUT/github-happy" "$PACKAGE"
./run.sh "$HOST" github-recovery "$OUT/github-recovery" "$PACKAGE"
```

Both discover and invoke the installed OAuth MCP documents `ReviewIssue($input: ReviewIssueInput!)` and `IssueReview($runId: ID!)`. The reports record the packaged mutation hash shared with the Forgejo cases. They exercise the GitHub OAuth repository-authorization callback, the App installation JWT and token flow, the pinned checkout broker, the app coordinator, and the independent reviewer. The exact base is `release/review-fixture`. The fixture denies dispatch before GitHub authorization, and tests the wrong tenant, repository ID, base SHA, and unknown run ID.

`github-happy` starts a fresh review and verifies its replay. `github-recovery` starts from a retained failed checkout attempt seeded into the disposable app and platform databases. It requires the original run to stay failed, concurrent recovery requests to resolve to one child, and repeated progress reads and recovery to preserve the completed result.

The box runs with networking disabled. A local service implements the GitHub REST and GraphQL contracts. It verifies synthetic App JWTs and installation grants, and uses native Forgejo and Git as the disposable state backend. The gateway's exact Git fetch is redirected to the backend after checking the installation credential and requested fetch format. Both real workspace checkouts are detached and have no Git remote. The provider fixture simulates GitHub's signed-commit verification fields and account attribution. This setup measures the host and app behavior against those provider contracts. It does not exercise the live GitHub service or live DGX Spark.

The grader checks one branch, commit, draft pull request, and exact-head formal review. It independently reads the Git parent, changed files, commit bytes, and issue and pull state. Keep the raw output private. The report and request journals identify the simulated provider calls and the separately observed Git state.
