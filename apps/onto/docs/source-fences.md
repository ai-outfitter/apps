# Source-local type-membership fences (draft v1)

This is an independently advertised capability, `outfitter.onto.source-fence@1`
with `source.fence.type-membership.v1`. A graph-only Onto provider does not promise
it. Bind `resolveOntoSourceFence(host, { installationId })` explicitly. Ordinary
host dispatch authenticates and authorizes every call; a provider reference,
proof ID, marker node or source scope never grants access.

This staged primitive binds an **already retained, immutable graph-node subject**
to a server-observed source snapshot in that same installation. It is useful for
retained report context, not general report generation capture. It does not prove
that the subject was derived from the evidence. It implements neither arbitrary
GraphQL completeness nor organization-rooted domain query semantics. Existing
Planning/Governance writers, seals and gates remain authoritative. Their migration
needs separate output, identity, history and query/gate parity acceptance.

## Reviewed selection and capture

An owner/admin calls `source.define` with a new immutable definition version.
The only selection is `whole-owner-type-membership-v1`: explicit node/edge type
IDs and explicit archival flags, plus optional additional record addresses.
Whole owner means the authenticated installation's personal **or** organization
owner. No slug selects or widens the owner. Protocol marker types cannot be
selected. A changed definition requires a new version.

`source.capture` accepts the definition identity and a same-installation immutable
subject reference, revision and canonical **entity attributes** digest. It accepts
no completeness or caller-authored proof. The server reads the selected sets,
including empty sets, and records type revisions and additional record revisions.
Each membership read selects only its configured type with a 2,001-row overflow
limit; subject, type metadata and additional records use exact ID lookups. The
snapshot retains the additional records as well as selected membership records.
It verifies the subject against the ordinary entity provider, using
`sha256Hex(canonicalActionValue(entity.attributes))`, the same digest convention
as entity-backed review subjects. This is not an Onto document content digest.

Capture issuance creates an immutable proof marker through the existing atomic
`graph.apply` transaction with those preconditions/read sets. Only a matching
server-private proof row **and** the exact graph change request hash/receipt can
make the proof issued. Ordinary graph writes and imports can create lookalike
marker nodes; those nodes are never proof authority. The public capture includes
the bounded selected snapshot, deterministic snapshot digest, server observation
instant, definition digest, and complete membership sets.

Limits are 32 membership sets, 2,000 records per set, 100 total revision
preconditions (including marker type), and 512 KiB of encoded proof/snapshot.
Exceeding a limit refuses issuance instead of returning complete partial evidence.
A proof admits new fence attempts for five minutes. In-flight attempts that were
admitted before expiry may finish; a confirmed historical receipt remains
reconcilable after expiry. A replayed capture retains its original instant and
expiry. It never refreshes old evidence silently.

## Atomic source seal and recovery

`source.fence` accepts a stored proof ID, its exact captured subject and an
idempotency key under current editor authority. The server verifies its private
proof, canonical digests, owner, provider, immutable marker type, issuance receipt,
definition and admission expiry. It writes a private durable pending transition
before attempting the source write.

The seal is an immutable graph-node created by `graph.apply`, atomically with
all captured type/record revision preconditions and full membership read sets.
A source insertion, removal, archive transition within the declared selection,
record change or type change conflicts. Empty sets detect new competing records.
The returned seal reference/digest uses the ordinary entity attributes convention.
A source seal is an integrity receipt, never business approval.

The deterministic seal ID, original actor and exact canonical graph request hash
bind recovery to that transition. `source.fence-status` reconciles the pending
request against the source-owned graph change receipt and exact immutable marker
contents. A copied marker with a different or missing graph receipt cannot seal
anything. Identical concurrent requests converge; changed reuse conflicts.
Unknown outcomes remain pending and inspectable. Only the initiating member can
resume an uncommitted operation; a currently authorized editor can reconcile an
already committed receipt. All replay/reconciliation calls recheck current
installation/editor authority.

There is no distributed transaction with another source, a report store or a
policy app. Consumers must retain their own pending transition and reconcile this
source receipt before declaring their transition complete. Definitions, proofs
and transition rows are server-private installation tables in migration
`0015_source_fences`; portable graph imports do not populate them. The existing
baseline stays unchanged and fresh/legacy installations apply this tail normally.
