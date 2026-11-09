# Amend a batch without approving it

Use the published `ReviseBatch` document, or `ChangeBatchChanges` with action
`amend` and a stable item key. Pass `batchId`, `proposals` and/or `remove` refs.
A proposal with an existing ref replaces that undecided proposal; a new ref adds
one. Record addresses and staged refs use the same format as `stage`.

Only an editor using their own member session or OAuth connection may amend a
member-review batch. Apps, delegated writers and resident principals cannot.
Decided proposals cannot be replaced or withdrawn. Policy batches cannot be
amended through this operation.

An open batch remains open. A submitted batch remains `awaiting_review`, keeps
its policy and deadline, validates the complete proposed graph and anchors, and
queues a fresh advisory review. Amendment never approves or commits records.
Concurrent graph changes or decisions cause a conflict; reload before retrying.
Stable `ChangeBatchChanges` keys reconcile lost responses without repeating writes.
