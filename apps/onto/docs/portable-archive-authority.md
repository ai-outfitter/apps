# Portable archives and local authority

An installation archive is an owner/admin backup of database rows. A preview
token confirms the selected archive and destination state; it is not a signature
or proof that the archive came from a trusted installation. Export retains all
app tables, including execution history and receipts. Portable import is a
separate operation with explicit exclusions.

[`archive-authorities.ts`](../src/server/archive-authorities.ts) registers the
rows that portable import must leave alone. Document definitions require the
admin-controlled, validated definition API. Document heads, jobs and run bindings
are local execution state. Generated revisions, captured provenance, seals,
lifecycle events and publication receipts are server-owned claims. Review jobs
are local advisory execution state. These rows cannot be recreated as authority
from caller-authored archives, even when the archive carries a valid preview
token or matches the current owner.

Without this boundary, an imported seal could satisfy export readiness despite
a required policy denying the seal operation. An imported publication could
claim a pull request that was never created. Imported generation state could
claim a completed report and workflow run, and imported events could redispatch
a sealed transition under new event IDs. The import exclusions preserve the
existing destination rows and skip incoming authority rows; they do not delete
history. Normal in-place database upgrades keep local history and authority.

New authority or runtime-state tables must be added to this registry before
their import path is exposed. The archive integration regression checks every
`document_*` table and verifies actual HTTP preview/import skips its rows while
owner backup export retains them. A future trusted disaster-recovery mechanism
would need its own authenticated restore design and installation identity rules;
portable import does not provide it.

This change does not certify graph-row import against every ordinary mutation
invariant. The existing generic graph import validator checks referenced types
and endpoint existence, while the SDK can accept a higher-revision incoming
row. Immutability and ontology validation across those writes require a separate
atomic validation design. Imported graph markers are therefore not independent
proof of generation, approval, a source fence or a completed external write.
