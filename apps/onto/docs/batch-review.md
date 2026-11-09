# Ontology review of change batches

Every submitted Wiki change batch gets an advisory review from the Wiki's ontology
steward ([prompt](../agent/ontology-steward.md), "Review one batch"). The review checks
that what the batch adds belongs to the owner's graph and makes ontological sense, and
attaches findings to the batch and its operations. It approves, rejects, holds and
commits nothing. See [the knowledge graph](../../../../docs/architecture/knowledge-graph.md)
for how batches fit the Wiki's writes.

## Implemented

- **When.** `SubmitBatch` and `batch.submit` start the review after the batch's policy has
  decided. It runs in the background once the response is sent (the request's
  `waitUntil`), so submitting never waits for it; `review` stays null until it finishes. A member can ask for a fresh review with **Review again**
  on the batch's Changes page (`POST /api/apps/wiki-map/batches/steward-review`, editors
  only). An open or discarded batch is not reviewed.
- **What runs.** One `batch-review` workflow run per review
  ([workflow](../workflows/batch-review/workflow.yaml), `src/server/batch-review.ts`):
  1. Deterministic checks over the batch, as if it all committed: `project.foreign`
     (error) for a created Project with no `part_of` path to the owner or one of its
     business units and no Planning source, and `node.isolated` (warning) for a created
     record with no relationship. `owner.unknown` says when no single Organization is
     bound to the Wiki's organization, so the owner checks could not run.
  2. The steward prompt over the batch's operations, the existing records they touch
     with their relationships, the types and the check results, through the platform's
     `inference.generate`. The model's findings are added beside the checks.
  3. `workflow.collect` records the findings, counts, coverage and prompt digest as the
     run's output.
- **Storage.** The batch keeps its latest review in `graph_batches.review`: state,
  `runId`, prompt path and SHA-256 digest, start and finish times, `complete` (false when
  the batch or its neighborhood was read in part, or the steward failed), summary,
  findings by operation `ref` (null for the batch as a whole) and any error.
- **Audit trail.** The workflow run is the audit trail. Each review, including a re-review,
  is a new run in the platform's WorkflowRuns log with its inputs (the batch ID), the
  inference call and the collected findings. The batch links its latest run; earlier
  runs stay in the log.
- **Display.** The Changes page shows the review section (summary, coverage, prompt
  digest, the run's ID, batch-level findings) and each operation's findings beside
  it. Batch cards show error and warning counts. Agents read the same object as
  `review` on the `ChangeBatch` document and in `batch.get`.
- **Failure.** If the run cannot start (for example, the submitter may not start
  workflows) or the model fails, the review is saved as `failed` with the built-in
  checks. Submitting never waits for or fails because of the review.

The review is advisory by decision (2026-11-07): commit behavior is exactly what the
batch's policy decides without it. A confidence or first-run batch still commits on
submit, and a member still decides the rest.

## Proposed, not implemented: gating as a governance control

Letting the steward's review change what commits is deferred. When it is built, it
should be a Governance control that an organization adopts explicitly, not a Wiki
default, because it moves decision weight from members and policies to an agent.

The proposed control:

- **Hold policy commits until the review finishes.** A confidence or first-run batch
  waits for its review before committing anything by policy, with a deadline after
  which it either commits as today or waits for a member (the control chooses).
- **Route errors to members.** An operation with an `error` finding is excluded from
  policy commits and waits for a member, with the finding shown as the reason.
- **Only stricter by default.** The steward can hold or route work to a member. Letting
  it approve or reject on its own would be a separate, explicit grant under the same
  control, recorded as the steward's decision, never as a member's.
- **Duties.** The control names who holds the steward duty (a resident or the Wiki's own
  workflow) through Governance role assignments, so Wiki stays domain-neutral.
- **Audit.** Every decision the control causes cites the review run that caused it, and
  the batch's history keeps each review (prompt digest, model or runtime, run ID, times,
  coverage and findings) instead of only the latest one.

Until then `requireMemberReview` stays as it is: decisions come from a member or the member's own connection, never from the steward, an app or a resident.
