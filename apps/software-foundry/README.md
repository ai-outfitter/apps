# Software Foundry

Software Foundry is the Outfitter app for approved GitHub issue and delivery workflows. The demo contains staged data; the operational package uses an installation database, scoped storage, connectors and workflow packages.

Run `npm run check --workspace apps/software-foundry`, `npm run test --workspace apps/software-foundry`, and `npm run build --workspace apps/software-foundry` from the repository root. Browser tests require Playwright Chromium. The tests for the real Wiki integration require `OUTFITTER_WIKI_PACKAGE` to point to a built Wiki operational package; otherwise those two cross-app scenarios are reported as skipped. Run them in an environment with the Wiki package before accepting a change to the integration.

## Enabling a repository

Foundry starts work only on repositories its organization installation has turned on (role agents plus an issue subscription). Otherwise `RequestChanges` records the issue and answers "execution is not configured for this repository". An organization owner or admin turns a repository on with the `RepositoryChanges` mutation (action `enable`, input `{ repository }`) over MCP, and repeats it to refresh after a Foundry change. The repository's gating checks come from `foundryChecks` in `src/server/workspace/workspaces.ts` and are recorded when it is turned on.

## Sidebar work and design review

Foundry opts its existing private conversation into platform agent delegation.
Delegated requests use the same agent and proposal review as **Ask Foundry**.
Work requests and repository jobs prepare proposals; the member must review them
in Foundry before anything starts. The job action is offered only to organization
owners and admins with editor access, and applying it rechecks the workflow host's
current authority and repository access.

For a UI or design review, request `job.run` with `job: "ui-review"` and a named
repository. This reuses the Jobs page's runner, not a separate review workflow.
Foundry must already be enabled there. The job selects one app by its existing
ISO-week rotation, reviews that app's pages at desktop and phone sizes, and can
file up to three screenshot-backed remediation issues. It does not accept a
selected app or arbitrary page URL from the sidebar;
these can start Foundry's issue-to-merge workflow. The Jobs page shows runs.
An interrupted approval is retained for inspection rather than retried, because
starting a job has no replay-safe request ID. Scheduling remains available through
the Jobs page and the published `JobChanges` document.
