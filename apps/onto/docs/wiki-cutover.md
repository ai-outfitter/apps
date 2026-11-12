# Wiki → Onto cutover audit and rehearsal

## Pre-graph Wiki page compatibility

Some older Wiki installations still have the original `wiki_pages` table and
`wiki_assets`, `wiki_links`, and `wiki_contacts` tables that refer to it. The
document Wiki's immutable `0012_documents` migration creates a different
`wiki_pages` table. Do not delete, overwrite, or mark `0012_documents` applied
to work around the name collision.

First complete the trusted `migrateWikiOwner` graph cutover and verify its
receipt, destination native read, and source write lock. The operator archives
every original page and child row in `onto_wiki_migration_sources`; every old
page must also map to a graph node. A destination that already has the empty
`0001_wiki_migration_lineage` schema can be used without rerunning that
migration. A nonempty destination lineage requires separate reconciliation.

Then run the Wiki compatibility operator with the new migration receipt:

```sh
CLOUDFLARE_ACCOUNT_ID=<account-id> CLOUDFLARE_API_TOKEN=<token> \
  node --import tsx apps/wiki/scripts/reconcile-legacy-pages.ts \
  /private/cutover/receipt.local.json /private/cutover/pages-plan.local.json

CLOUDFLARE_ACCOUNT_ID=<account-id> CLOUDFLARE_API_TOKEN=<token> \
  node --import tsx apps/wiki/scripts/reconcile-legacy-pages.ts \
  /private/cutover/receipt.local.json /private/cutover/pages-apply.local.json --apply
```

Use a fresh private backup path for each invocation. The first call reads and
captures the old rows only. The second requires matching Onto lineage and
source graph write locks, backs up the page and child rows, and renames the old
table to `wiki_legacy_pages`. SQLite retargets child foreign keys and the
original table's write locks to the archive. The operator verifies row hashes
and foreign keys after the rename. If a response is lost, inspect the source
schema and backup before retrying; a second rename is refused.

Finally retry the ordinary Wiki upgrade. `0012_documents` and
`0013_imported_revision` create and populate the new document tables. Check
the archival row counts, child foreign keys, document counts, and
`PRAGMA foreign_key_check` after the upgrade.

Onto owns the graph. Wiki owns authored documents, pages and reports, reading
Onto through the public graph contract. This is the current product boundary in
[the graph database plan](graph-database-plan.md). The hosted platform's older
`docs/architecture/onto.md` still describes document generation inside Onto;
reconcile that historical architecture before implementing the document Wiki.

## Audit before provisioning or switching reads

Run the read-only, account-authorized audit with a private OAuth file:

```sh
OUTFITTER_ACCESS_TOKEN_FILE=/private/outfitter-oauth.json \
  node apps/onto/scripts/audit-wiki-cutover.mjs \
  https://ai-outfitter.com /private/new-wiki-audit-directory
```

The parent directory must already exist outside Git. The output directory is
exclusive and private (0700); files are exclusive and private (0600). The command
verifies identity, organization consent and all currently visible memberships.
It inventories the personal owner and every organization, including owners with
no installed Wiki or Onto. It captures complete paginated archives of each Wiki
and existing Onto using ordinary authenticated installation APIs, hashes each
page, and records incomplete or unauthorized captures as blockers. A successful
archive is evidence of capture, never evidence of a migrated installation.
Additional accounts need their own sign-in and inventory; memberships for one
identity do not establish access to another identity's data.

Archive pages are sequential reads rather than an atomic cross-table snapshot.
Freeze source writes and capture again for the actual migration. Download binary
assets separately and verify content hashes and destination storage bindings.
Portable graph exports alone omit authority, workflow history and canonical app
records; they cannot establish complete migration parity.

## Source audit (2026-11-09)

Audited public apps main `8182cff` and hosted webapp main `454e2b42`:

| Surface | Current implementation | Required cutover work |
| --- | --- | --- |
| Personal and organization ownership | One installation per template per owner; each operational installation gets its own database | Inventory and provision one Onto for each explicitly authorized owner; verify actual installation/database activation |
| Graph persistence | Bundled `catalog/apps/wiki-map`; public `apps/onto` has a fresh schema | Rehearse trusted backup conversion and reconcile every refusal before activation |
| SDK discovery | Hosted `packages/app-sdk/src/wiki.ts` and public `graph-client.ts` `defaultWiki()` still discover `wiki-map` | Bind graph clients to the verified Onto provider after parity checks, retaining a tested compatibility path |
| MCP | Hosted `src/lib/agent-graph-scope.ts` searches `wiki-map`; platform proposals name Wiki | Switch graph discovery and mutation routing together; avoid federating both copies as independent facts |
| Dependent apps | Hosted Planning, Governance and Forerunner depend on Wiki; public Workshop, Foundry and Creative Team do too | Change dependencies, initialization and graph calls to Onto; validate each owner and app |
| Confirmation and history | Confirmation hashes, change receipts, revisions, proposals and durable review jobs | Preserve trusted lineage and history; generic portable archives cannot recreate approval authority |
| References | Canonical app references include installation IDs; batches and proposals may embed them | Inventory and explicitly remap installation-qualified references; UUID preservation alone is insufficient |
| Wiki documents | Existing note bodies and document/report records coexist with graph records | Define a document-owned schema and preserve document IDs, history, assets and graph citations during conversion |
| Seed definitions | Old types may be authored or lack endpoint contracts | Preserve authored definitions; explicitly reconcile endpoints instead of silently replacing or widening them |
| Runtime and schedules | Source/destination jobs and workflows have installation identity | Pause source writers and review jobs, verify replacement identities, resume only after receipts/readback |
| Private data | Old node `privateData` has no destination in graph-only Onto | Explicit owner-scoped retention mapping; never silently discard it or put it in a public repository |

Live owner inventories, identities, graph bodies, account mappings and capture
receipts stay outside this repository. This document contains no customer data.

## Offline conversion rehearsal

`scripts/import-old-wiki.ts` accepts an old trusted SQLite installation backup
and a **new, nonexistent** local SQLite destination. It opens the source read-only,
reads within a transaction, and inserts into the new Onto schema transactionally.
Existing files and symlinks are refused. New seed identities are add-only;
authored type definitions and revisions are retained.

The candidate is removed on failure. Missing endpoint contracts, rejected edges,
unknown populated tables/columns, unsupported identity providers, nonempty private
data and malformed JSON block success. History tables, review jobs and saved
explorations are included, and foreign keys are checked before committing.
Reconcile the source copy through an explicit reviewed mapping, then rehearse
again. Never weaken contracts or delete conflicting rows to obtain a green result.

This command does not authorize an installation restore, upload to D1, remap
cross-installation references, copy R2 assets, initialize hosted migration ledgers,
or activate any app. Retaining confirmation rows offline does not make them
authoritative in another installation. The trusted restore/lineage path must
verify those bindings before production use.

## Completion gates per owner

1. Verify account/organization authority, unique source and destination, source
   and destination package hashes, schema and capabilities.
2. Capture full backups, authority/history, storage assets and every embedded
   installation reference. Record counts and content hashes privately.
3. Rehearse conversion with zero refusals. Account explicitly for Wiki-owned
   documents and any fields outside the graph schema.
4. Freeze writes and jobs; take final backups; apply a verified trusted migration
   and retain a receipt for the exact owner, source/destination and hashes.
5. Read back records, revisions, history and assets. Check account isolation,
   stale/denied access, ordinary app reads/writes and registered workflows.
6. Switch SDK/MCP/app initialization to Onto and validate document Wiki links.
   Keep source recovery available until all gates pass; archive source graph
   storage only after verified cutover.


## Reconciled trusted operator migration

The user-authorized operator path is `scripts/migrate-wiki-owner.ts`, backed by
`scripts/wiki-migration-d1.ts`. It accepts an explicitly verified source and
destination installation/database pair for one owner, a captured destination
seed baseline, and callbacks which recheck current account authorization,
installation/database bindings and native app reads. It is never exposed as a
portable import or agent mutation. Credentials stay in the operator environment.

`scripts/reconcile-wiki.ts` creates a plan bound to the exact source digest. The
plan preserves an existing same-name type ID instead of adding a conflicting seed
identity, matching ordinary add-only initialization. Existing endpoint contracts
are retained. Missing contracts use declared seed endpoints only when every
preserved relationship fits; otherwise the legacy unconstrained semantics are
made explicit and recorded. Authored definitions remain intact. Each changed
type gains a revision with its prior snapshot and a migration reason; existing
revision rows are retained unchanged.

The operator checks that the target still matches its captured seed baseline,
locks source and target writes, takes fresh backups, converts locally, retains
nonconflicting target seed records, and checks every original history row.
The new `0001_wiki_migration_lineage` forward migration records source/destination,
owner, source digest, reconciliation and verification. It also retains every
original source row, including legacy identity fields and pre-reconciliation type
definitions. Database triggers protect these lineage tables even while an older
app package serves them; portable-import exclusions remain required as well.

Rows load into staging tables. One D1 batch promotes the complete candidate, with
foreign keys deferred and types/nodes inserted before endpoint-checked edges.
Exact row hashes, foreign keys and a native Onto read are verified before target
writes resume. Source Wiki data stays available read-only to prevent divergence.
This migration does not redirect old application clients or convert Wiki pages;
those consumers must use Onto before legacy write paths can be retired.

A lost promotion response is inspected rather than blindly retried. Failures
before promotion restore source/target write access. An uncertain promotion or
failed verification remains locked, with private failure evidence and backups
available for explicit recovery. No automatic deletion of source data occurs.

Validation includes SQLite rollback, endpoint-trigger ordering, immutable lineage,
content-hash readback, source-change rejection and type-identity preservation,
plus an actual D1 rehearsal with a failed batch rollback and a full candidate
promotion/readback. Private production receipts are separate from repository
validation and contain the owner-specific result.
