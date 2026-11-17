# Guided research in Planning

A research brief is an optional extension of an existing intake, not a new app,
runner, routing service or permission grant. Existing intakes remain compatible.
Use `CreateIntake` with `research`: question, decision, owner (a descriptive label,
not an assignment), scope, exclusions, stoppingCriteria, timeboxMinutes and
successMeasure. For a competitive comparison, bound the question to one decision,
official evidence and a short timebox. Success can measure cost, elapsed time,
quality or a decision resolved; do not invent a numeric baseline.

Use the existing research route and Governance assignment. ClaimWork,
SaveResultDraft and RecordResult retain their normal access and review checks.
Choose an existing tool, notebook or report workflow; attach reviewable HTTP(S)
artifact URLs in result.research.artifacts. Those URLs grant no additional access.
Evidence stays in result.sources with observedAt and excerpts; uncertainties stay
in gaps. A conclusion records outcome (supported, rejected, inconclusive, blocked),
conclusion, stopReason, elapsedMinutes and artifacts. Supported/rejected outcomes
require sources; inconclusive/blocked require a gap. Legacy results need no new
fields unless their intake has a research brief.

The timebox is a guided stopping instruction, not a scheduler-enforced resource
limit. Stop on the agreed criterion, exhausted timebox, missing access or approval;
record a truthful partial result rather than expanding scope. Elapsed time is
worker-reported, not a telemetry measurement. Use ReviseIntakeScope to change a
brief: existing revision checks and result history preserve the previous decision,
and new child identities invalidate old approvals. Omitted research on revision
preserves the current brief.

PublishResult uses the existing proposed Onto ResearchFinding assertion. The
outcome, conclusion and stop reason accompany its uncertainty; sources retain
provenance. This does not accept canonical facts or approve delivery. Full brief,
artifacts and conclusion remain in Planning. A reviewer decides reusable knowledge
changes through existing Onto review, and any implementation separately follows
the existing reviewed handoff. No auto-merge or autonomous research loop is added.
