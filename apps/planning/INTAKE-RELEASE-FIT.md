# Conversational intake and release fit

Planning owns intake; Chat and other agents use its published named documents through
`graph_query` and `graph_mutate`. No separate task system or copied transcript is required.

1. `CreateIntake` persists the request under a stable UUID `requestId` and routes the
   existing research, architecture, prioritization and delivery work. Optional
   `originatingMessage` holds caller-provided thread/message provenance only. Retry
   the identical input with the same request ID; changed content is refused.
2. `Intakes` reads the persisted request, project, routes, claims, findings, blockers,
   release fit and history. Use its `first`/`after` variables to page.
3. `RouteIntake` assigns the canonical project. `IntakeReleaseOptions` reads that
   project's existing Wiki Release records and revisions using the ordinary scoped
   release reader. It creates no Releases.
4. `SetIntakeReleaseFit` records `current-release`, `deferred`, `needs-research` or
   `rejected`, with a rationale and optimistic intake revision. `current-release`
   requires an existing project-linked Release ID and revision. A deferred request
   without a future Release remains in the existing intake backlog (`backlog: true`).
   Decisions retain actor, timestamp and earlier decisions; scope revision archives
   the old fit and requires a fresh decision.
5. `ClaimWork`, `SaveResultDraft`, `RecordResult` and `PublishResult` retain existing
   assignment, evidence and Governance checks. A release-fit decision does not
   approve findings or override the prioritization result.
6. `IntakeWorkPreview` and `SubmitIntakeWork` reuse the existing Foundry package,
   digest, source revision, Governance and retry contracts. Explicit dispositions
   other than current-release block delivery. A selected Release must still be at
   the recorded revision. The package cites the current fit as a revision-pinned
   `intake-release-fit` entity; changing the fit requires a fresh package preview.
   Submitted or uncertain delivery freezes fit changes.

Existing intakes without a release-fit decision retain their existing execution
behavior. Conversation provenance grants no transcript access and does not prove
that a source message exists; the agent must use the same request ID on retry.
This foundation does not automatically create an intake from every conversation,
choose a current Release by date, or create new release schedules.

Planning's shared sidebar now asks the next missing problem, project, scenario or
release-fit question. The ordinary project/products conversations offer the same
published documents through the platform tools; the intake conversation offers
reviewed app-owned proposals plus scoped project, release and full use-case reads.
Both providers supply the current thread/message and a deterministic capture request
ID in server-prepared `conversationSource` context. This keeps the proposed source
linked to the actual conversation rather than asking the member to find identifiers.
The stored source field itself remains caller-provided provenance.

`UseCases` reads complete project-linked scenario documents and `SaveUseCase`
authors actor, goal, trigger, steps, alternatives and success criteria. Read first
before edits or retrying a create whose response was lost. `ProjectDelivery` now
includes `intakeDecisions`: release-fit history's current decisions and actionable
questions for the latest 100 project-linked intakes, with explicit truncation.
Reports can quote these pending questions without presenting them as approvals.
Main Chat already receives `graph_documents`, `graph_query` and `graph_mutate`
from the platform; publishing Planning's documents uses that existing route.
