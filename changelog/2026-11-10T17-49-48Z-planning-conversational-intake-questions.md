Planning conversations now guide an idea through the missing problem, project,
complete use case and release-fit questions, with server-prepared conversation
source context. The existing intake sidebar offers project/release/scenario reads
and reviewed release-fit/use-case proposals. Main Planning conversations point to
the existing MCP document route, and full UseCases/SaveUseCase documents are
published for scenario authoring. ProjectDelivery includes bounded project-linked
intake decisions and pending questions for reports and follow-up conversations.

Validation: 49 focused intake, document, conversation and delivery tests pass;
Astro check reports zero errors with independently installed worktree dependencies.
The shared defaultFocus component API is retained; the earlier mismatch came from
resolving a stale sibling checkout dependency. Fixture inference only; no deployment.
