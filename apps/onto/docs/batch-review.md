# Ontology review of change batches

Every submitted Wiki change batch gets a review from the Wiki's ontology
steward ([prompt](../agent/ontology-steward.md), "Review one batch"). The review checks
that what the batch adds belongs to the owner's graph and makes ontological sense, and
attaches findings to the batch and its operations. It then approves what it found clean
and leaves the rest for a member ([steward approval](#steward-approval)). See [the knowledge graph](../../../../docs/architecture/knowledge-graph.md)
for how batches fit the Wiki's writes.

## Implemented

- **When.** Submission queues a durable review. An editor-owned `batch-review` schedule
  picks one current batch per occurrence and records its ID in the run. Save the
  six-hour schedule with empty inputs. Editors can also review a submitted batch
  immediately with **Review again** on its Changes page, or send
  `{"batchId":"<batch UUID>"}` to `POST /api/apps/onto/batches/steward-review`
  once per batch.
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

## Steward approval

Members are not the only reviewers (decision 2026-11-15: "the onto agent should review and
auto merge if it looks good"). When the review of a submitted batch finishes, the steward
approves what it found clean, and the rest waits for a member on the Changes page. It
applies to every batch policy. An admin can turn it off on the Settings page ("After the
steward reviews a batch": approve what it found clean, the default, or only review), or
with `SaveSettings {stewardApproval: "approve" | "review"}`; `OntoSettings` reads it.

- **Clean** means no `error` or `warning` finding names the operation (by `ref` or
  `refs`), from the checks or the steward, and no unanswered question on the batch names it.
  A `note` never holds anything, and an answered question no longer holds.
- **Held for a member:** each flagged or questioned operation, and every waiting operation
  that depends on one (`withDependents`, as a rejection would). A batch-level `error` or
  `warning`, a question without refs, or a review that read only part of the batch
  (`complete: false`) hold everything. A failed review decides nothing; it is retried, and
  a member can decide meanwhile. A created record that would not reach an
  anchor without a held operation is held too.
- **Recorded as the steward's,** never a member's: each approved operation's decision and
  its history row carry `{kind: "steward", runId, prompt, reason: "clean review", at}`, so
  the review run that caused it is the audit trail. `decidedBy` stays empty.
- **Saved on the review** as `decision: {approved, held: [{ref, reason}], at}`; the
  Changes page says what the steward approved and why the rest waits.
- **Guarded:** the steward approves only for the review job that is still the batch's
  (`reviewJobId`), with the same row snapshot guard as a member's review, so an amendment
  or a member's decision in between wins. A subset that no longer applies commits
  nothing and waits for a member.
- **Review again** on the Changes page runs the same approval after the new review.
- **Waiting on it.** Each review job reserves its workflow run ID when it is queued. While
  the review is queued or running, the batch's `reviewRun` is `{runId, state}` and its
  receipt (`SubmitBatch`, `ChangeBatchChanges` submit) carries the SDK's required
  `WAIT_FOR_RUN` instruction with that run as `taskId`. The agent waits on the run
  (WorkflowRuns at scope platform) or reads the batch again; once the review finishes,
  `reviewRun` is null and `review.decision` says what was approved and what waits. A retry
  or a scheduled pickup starts a run of its own and saves its ID on the job.

The steward never rejects. Member review (`requireMemberReview`) is unchanged: a member, or
the member's own connection, still approves or rejects whatever the steward held.

## Repairing a draft

`ChangeBatchChanges` returns `validation: { valid, error, operations }` and anchor
node addresses after staging, removing or configuring proposals. A failing draft
is durable and invisible to normal graph reads; its receipt asks the caller to
`REPAIR_CHANGES`. Fix it and validate again before explicit submission. Passing
validation does not approve or commit a proposal.

Use `stage` with `replace: true` to replace proposals at their existing refs,
including evidence, confidence and reason. Other refs stay unchanged. `configure`
replaces the anchor addresses (`[]` clears them). Every newly created node must
reach an anchor through saved or proposed relationships, in either direction.
An undecided batch awaiting member review may change its anchors only if its
existing proposals already satisfy the new anchors. Submitted operations stay
frozen and review decisions remain a member's step.

The Changes workspace opens on its graph. Proposal details and review/anchor
settings have separate views, and clicking a proposed node opens its proposal.
Dragging pans the graph in both directions, including on touchscreens.
Wheel or trackpad scrolling zooms in and out around the pointer; toolbar zoom
controls keep the center fixed. Expand graph fills the window; Escape returns to the workspace.
