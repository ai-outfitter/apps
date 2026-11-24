# Editing a proposed batch through MCP

Read the batch with `ChangeBatches(details:true)`. Send one `ChangeBatchChanges` item with action `amend`, a stable item key, the batch ID and its observed `expectedVersion`. In `proposals`, an existing ref replaces that pending proposal and a new ref adds one. List refs to withdraw in `remove`. Include the evidence and metadata you intend to retain on replacement proposals.

To reuse a saved Person, replace the pending relationships with copies whose relevant endpoints name the canonical Person address. Withdraw the redundant Person create in the same edit. Onto validates the resulting batch and its anchors together. Previously decided records keep their decisions.

Submitting a draft records version 1. Amending a submitted batch records the new proposal content, increments submittedVersion and queues a fresh steward review under the existing policy. Use `BatchSubmission(id, version)` to compare what was submitted. Draft edits stay open. A zero version means no tracked submission yet. For a legacy submitted batch, the first edit retains the observed baseline at version zero with unknown authorship.

Editors and delegated entity writers may edit member-policy proposals. Graph type changes require an editor. On batches with automatic commit policies the originating app or a member reviewer may edit. A conflict means another submission or review changed the batch. Reread it before reapplying an edit. Retry a lost response with the identical item key and inputs.
