# Wiki

The document and page app, published from this repository and installed under
its existing `outfitter/wiki-map` identity. Onto owns the knowledge graph.

Applied migrations 0000–0011 are preserved from the original bundled Wiki.
Migration 0012 imports Document nodes and their recorded revisions without
modifying the archived graph. All archive tables remain available through the
read-only authenticated export route. Generic restores cannot manufacture
revision or approval history.

Graph behavior and its integration/browser suites belong to `apps/onto`.
Wiki tests cover migration/history, revision conflicts, protected publication,
rendering, and the installed document API. The old graph implementation remains
in repository history; it is not included in this app's runtime.

Run `npm run check`, `npm test`, and `npm run test:e2e` in this directory.
Schema/documents: `node --import tsx scripts/document-schema.ts`.
Production activation requires the released package descriptor in webapp and
verified consumer upgrades. Do not delete the bundled source before that gate.

## Upgrade and rollback

Before activation, freeze graph writes and take consistent SQLite snapshots of
all source Wiki and destination Onto installations plus an inventory of object
storage keys. Keep snapshots, checksums and receipts outside Git. Rehearse each
source with Node 24:

```sh
node --import tsx scripts/rehearse-upgrade.ts /private/source.sqlite /private/candidate.sqlite /private/receipt.local.json
```

This creates a new candidate, applies pending document migrations, checks every existing table
is unchanged, and checks SQLite integrity and foreign keys. It never updates the
source snapshot. The candidate is for inspection, not installation: the platform
must register and apply pending migrations through its normal upgrade lifecycle.

Release the tested package and pin its immutable source, manifest, package and
provenance digests in webapp. Verify document IDs, content, revisions, citations,
file URLs, old links, access restrictions and Onto references at both personal
and organization mounts. Leave the bundled implementation available until the
released external package passes mounted acceptance.

Migration 0013 tracks the last imported legacy revision. Initialization rechecks the frozen source and resumes an interrupted import before serving the new app; an authored or published Wiki revision is never replaced by a later legacy head.

A code-only rollback is insufficient. Stop writes, capture all new document
revisions and publication receipts, and retain the converted database and object
storage. Prefer repairing the external package forward. If restoring an earlier
snapshot is necessary, reconcile post-cutover document writes before switching;
do not reopen the archived graph for edits or discard newly authored history.
