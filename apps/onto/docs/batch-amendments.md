# Submitting and editing proposal batches through MCP

Use `MutateBatchSubmission` with a stable `requestKey`, a title and the proposed changes. You can pass a caller-generated UUID as `batchId` or use the ID Onto returns. Onto validates the proposals and their anchors together, saves version 1 and queues the steward review in one transaction. An invalid submission saves no batch, proposals or review job. To iterate in an open draft, use `ChangeBatchChanges` with `stage`.

To edit, read the batch with `ChangeBatches(details:true)`. Send the batch ID and the current `submittedVersion` as `expectedVersion` with a fresh `requestKey`. In `proposals`, an existing ref replaces an undecided proposal and a new ref adds one. List refs to withdraw in `remove`. Include the evidence, confidence and reason you intend to retain in each replacement. Use version zero to submit an open draft or amend a legacy submission that predates version tracking.

To reuse a saved Person, replace the pending relationships with copies whose relevant endpoints name the canonical Person address. Withdraw the redundant Person create in the same edit. Previously decided proposals keep their decisions.

An accepted edit saves the next version and queues the remaining undecided refs for review under the existing policy. `reviewRefs` identifies those proposals, and `reviewRun` identifies the reserved workflow run when there is pending work. Check the batch after the run for current decisions. Use `BatchSubmission(id, version)` to read the immutable submitted proposals. For a legacy batch, Onto saves the observed baseline at version zero with unknown authorship.

Editors and delegated entity writers can submit or edit member-policy proposals. Graph type changes require an editor. On submitted batches with automatic policies, the originating app or a member reviewer can edit. Existing review authority applies to every approval or rejection.

Retry a lost response with identical inputs and the original `requestKey` to recover its receipt. A version conflict means another submission changed the batch. Reread it before retrying the edit with a new key. The existing `ChangeBatchChanges` and `ReviseBatch` documents remain available.
