# Relators for measurable goals and controls: pilot design

> Part of [the knowledge graph](../../../../docs/architecture/knowledge-graph.md), Outfitter's central architecture for Wikis, ontology, reads and writes.

The architecture these pilots feed is [goals and metrics](../../../../docs/architecture/goals-and-metrics.md).

Status: pilot design with shared relator definitions and local seed examples.
No PostHog integration, control activation, graph migration, or SemLang/Malloy
compilation is delivered. The objective is to test a few useful semantic patterns before
expanding the standard ontology.

The representation target is **SemLang and Malloy**, as confirmed by the user.

## What we are trying to support

A person or organization sets a measurable goal, accepts a scoped commitment,
observes relevant events, and can see whether the commitment was met. A control
adds an explicit evaluation rule, accountable owner, evidence requirements and
an action when the rule is not met. Governance can approve, amend and review
that control; a personal goal need not acquire a board or approval ceremony.

The pilot questions are:

1. Was each qualifying production issue addressed within eight elapsed hours?
2. Did I see a particular friend at least once this calendar quarter?
3. Did I complete a workout today, or three workouts this calendar week?

These are modelling examples, not facts about the user's behavior. Definitions
can be useful before there is evidence for any particular instance.

## Choose by meaning, not by storage convenience

| Concept | Meaning | Example |
| --- | --- | --- |
| Kind / entity | A durable thing with its own identity | Person, service, error issue, workout practice |
| Edge | A named association; the association itself needs no independent identity | An issue concerns a service; a control measures a goal |
| Relator | An independently identifiable relationship or commitment among participants, with its own terms, scope or lifecycle | Friendship; responsibility for a control; an obligation to respond to an issue |
| Event | Something occurred | Exception occurrence, response recorded, meeting completed, workout completed |
| Situation / evaluation | What was true for a subject, window and observation cutoff | Weekly workout count; response obligation overdue as of 18:00 |
| Assertion | A supported or disputed claim about a record | A user confirms that a meeting happened; source evidence supports a response |
| View / lens | A convenient derived way to browse or measure the same facts | Friends of a person; overdue obligations; weekly progress |

Use an **edge** when callers only need to traverse from A to B. Use a **relator**
when people need to name, accept, amend, pause, renew, terminate, assign evidence
to, or distinguish multiple episodes of the relationship itself. More than two
participants is a strong signal, not a requirement: Friendship can be a relator
with two people.

Dates or a note on an edge do not mechanically force a conversion: Wiki already
supports temporal edges. The decisive question is whether the relationship has
independent meaning and identity. A control referencing that relationship is a
particularly useful signal. Conversely, do not make each join, source record or
report into another node merely because the storage supports it.

A goal states the desired outcome. A control definition states how to test it.
The relationship accepting responsibility for that control is a relator. A
control definition is not automatically a relator just because it has a name
and version. An evaluation result is not another relationship.

## Small pilot vocabulary, not a universal standard catalog

The shared definitions now live in `seeds/control-pilot-types-v1.json`.
Forerunner owns the scoped seed instances in `scripts/control-pilots.ts`; see its
[manual discovery guide](../../forerunner/docs/manual-discovery.md#local-control-pilot-seeds).

| Proposed relator | Required participants | Its own facts | Pilot |
| --- | --- | --- | --- |
| Friendship | Exactly two distinct Persons | Identity of the friendship, optional effective interval and notes | Quarterly contact |
| ControlCommitment | One accountable Person/Role, one control definition version, one subject/scope | Acceptance, effective interval, active/paused/ended state, explicit amendments | All three |
| ResponseObligation | One qualifying issue episode, one applicable ControlCommitment | Trigger and deadline, disposition and response references; assignment history if needed | Eight-hour response |

Reuse existing **RoleAssignment** for the person who holds an accountable role;
do not create a second employment or board-membership model. A commitment may
point to a role so that personnel can change without restarting its obligations.
Retain the responsible holder at evaluation/response time for attribution,
including a revision or snapshot of the applicable assignment; later assignment
edits must not silently change historical evaluation results.

Do not introduce an Obligation node for every routine daily tick initially.
Routine windows can be derived rows. Materialize one only if that window needs
its own acceptance, reassignment, exception, waiver or workflow history.
PostHog obligations merit identity because individual issues have dispositions
and can be reopened independently.

The quarterly commitment is separate from Friendship. Changing a cadence does
not end a friendship; ending a commitment does not erase it. Likewise, changing
workout targets does not invent a new identity for the person or practice.

## Pilot 1: PostHog issue response within eight hours

### Scope and source semantics

PostHog groups similar exception events into issues. Evaluate one obligation per
qualifying **issue episode**, not one per repeated exception occurrence. An issue
that reopens after resolution starts a new episode; repeated events in an open
episode do not extend its deadline. PostHog documents grouping and reopening in
[issues and exceptions](https://posthog.com/docs/error-tracking/issues-and-exceptions)
and [managing issues](https://posthog.com/docs/error-tracking/managing-issues).

Illustrative scope: production issues in one explicitly selected PostHog project.
The owner must choose severity filters, handling of already-open issues and the
activation boundary. Do not silently include all historical issues or mix
personal and organization-owned source data.

“Addressed” is not yet a settled requirement. Before activating a real control,
the owner must choose one testable disposition:

- `triaged_with_plan`: diagnosis/disposition, accountable owner and actionable
  next step are recorded; acknowledgement or assignment alone is insufficient.
- `mitigated_or_resolved`: a mitigation or fix and its verification evidence
  are recorded; opening a ticket alone is insufficient.

Use `triaged_with_plan` only as the **illustrative fixture rule** below. The
second definition is stricter and would produce different results. Suppression,
accepted risk and waiver are separate outcomes; they are not automatic passes.
PostHog's current resolved status alone does not establish when a response met
our chosen rule or that a fix was independently verified.

### Identities and grain

- Issue identity: source installation/project plus stable issue ID.
- Episode identity: issue plus source-supported opening/reopening identity.
- Obligation identity: issue episode plus the applicable commitment version.
- Exception/event identity: source installation plus stable source event ID.
- Evaluation identity: obligation plus evaluator version and observation cutoff.

Required relationship: `ResponseObligation` links the issue episode to the
accepted commitment. `concerns_service` remains an ordinary edge from issue to
service. Events and evidence can stay in their source with stable references;
the Wiki need not mirror every exception as a page. If an obligation is stored
as a Wiki relator, its issue episode, commitment and other participant slots
must resolve to nodes in that same Wiki. The current slot contract does not
accept raw PostHog IDs or arbitrary cross-app references. Represent only the
selected episode/control-version identities needed for those links; keep bulk
exception occurrences and source payloads in source/evidence storage.

Set `due_at = triggered_at + 8 elapsed hours`. Store instants in UTC. This is
neither business hours nor an eight-hour local-clock calculation across DST.
Use the qualifying source opening timestamp; retain ingested_at separately.
Delayed ingestion must not reset the response clock. If opening/reopening
history is unavailable, report uncertainty instead of fabricating episodes.

### Evaluation

For a known trigger and sufficient source coverage:

| Condition at observation cutoff | Result |
| --- | --- |
| Qualifying response timestamp is on or before due_at | Met |
| Due time has not arrived and no qualifying response exists | Pending |
| Deadline passed without qualifying response | Breached |
| Qualifying response happened after the deadline | Breached, addressed late |
| Trigger, response history or source coverage is insufficient | Unknown |
| Explicit authorized waiver applies | Waived; reported separately |

The operational action may be a reminder, assigned task or escalation proposal.
Evaluating a metric does not itself authorize contacting people, suppressing an
issue, changing production, or manufacturing a member confirmation receipt.
An eventual delivery integration needs its own idempotent action receipt.

The attainment rate uses due, evaluable obligations only; report pending,
unknown and waived counts alongside it. Do not silently turn missing data into
compliance, or remove overdue unaddressed obligations from the denominator.

## Pilot 2: see a friend once per quarter

Use a Friendship relator for the two people and a ControlCommitment scoped to
that friendship. A read-only symmetric `friends_with` projection keeps browsing
simple. The cadence belongs to the commitment, not the friendship.

For this fixture, choose calendar quarters in `America/Chicago`, using half-open
local windows: January 1 through April 1, and so on. “Every rolling 90 days” is a
different policy and must not be substituted silently.

A calendar invitation is **planned contact**, not proof that a meeting happened.
Count a distinct completed interaction only after a permitted completion signal,
such as explicit user confirmation. Canceled events do not count. Match the
actual people, not a calendar title string or an email address treated as a
separate person. The user has explicitly supplied the friendship in this case;
the calendar alone does not establish it.

At quarter end, one qualifying interaction means met. Zero means not met only
if the chosen evidence source is sufficiently complete; otherwise unknown.
During the quarter show progress and remaining time, not premature failure.
This is a private personal commitment unless the user explicitly shares it.

## Pilot 3: workout daily or three times per week

Use one person, one identified workout practice and a ControlCommitment. The
practice definition says what counts as completion; do not invent a duration,
intensity or health threshold. A planned calendar workout is not completion.
A user log or supported activity record is evidence according to the accepted
rule, with stable IDs to deduplicate imports from multiple sources.

Two alternative policies test the same model:

- Daily: at least one qualifying completion per local calendar day.
- Weekly: at least three distinct qualifying completions per Monday-through-
  Sunday local calendar week.

Do not activate both as if the user requested two simultaneous obligations.
Use `America/Chicago` in the fixture; real commitments choose their timezone.
Use local calendar arithmetic for windows rather than assuming every day has
24 hours. A policy must decide how to handle sessions spanning midnight; the
fixture counts a completion in the window containing its completed_at instant.
One session cannot count three times because three trackers imported it.

Policy amendments are prospective and versioned. Changing three workouts to
five next week does not rewrite the result of last week. Missing source access
makes coverage unknown; it does not establish inactivity.

## SemLang / Malloy representation

Keep the graph's semantic identity while exposing typed relational populations:

| Population | One row per | Important keys/fields |
| --- | --- | --- |
| people / subjects | Stable real-world entity | id, source aliases |
| friendships | Friendship instance | id, two participant references, effective interval |
| control_versions | Immutable definition version | id, threshold, window rule, success criterion |
| commitments | Accepted responsibility relationship | id, owner/role, scope, control_version_id, effective interval |
| issue_episodes | Opening or reopening of an issue | id, source issue ID, triggered_at |
| response_obligations | Episode under a commitment | id, episode_id, commitment_id, due_at |
| qualifying_events | Distinct accepted occurrence | id, subject references, occurred_at, evidence reference |
| evaluation_facts | Obligation/window at an observation cutoff | id, status, count, due_at, as_of, coverage, evaluator version |

In SemLang terms, the commitments/obligations/friendships are relators, observed
completions are events, and evaluation_facts are situations. The same populations
can be exposed as Malloy sources with explicit keys, joins and measures. Malloy
should query the evaluator's facts; a report must not silently invent the
meaning of “addressed” or perform authorized actions.

Aggregate source events to one row per obligation or window **before** joining
multiple evidence records or participants. Otherwise joins can multiply counts
and corrupt the attainment rate. Keep unknown/waived counts visible. Start with
batch snapshots and a fixed as_of cutoff for reproducibility, rather than
promising continuous synchronization.

These are representation targets, not tested SemLang/Malloy syntax. The current
Wiki has no compiler/export adapter that makes these pilots executable. A later
spike must compile a tiny fixture, execute its queries, and compare the actual
result rows with the expectations below before claiming compatibility.

## Small fixture acceptance matrix

| Fixture | Expected result |
| --- | --- |
| Issue at 09:00Z, qualifying response at 16:59Z | Met |
| Same issue, response exactly at 17:00Z | Met |
| Same issue, response at 17:01Z | Breached, addressed late |
| No response, as_of 16:00Z / 18:00Z | Pending / breached |
| Ten repeated exceptions in one open episode | One obligation, unchanged deadline |
| Resolved issue later reopens | Separate episode/obligation; original result preserved |
| Late ingestion, missing opening history, or source outage | Clock unchanged where known; otherwise unknown |
| Response merely acknowledged or ticket merely assigned | Not met under the fixture rule |
| Authorized waiver after a missed deadline | Original breach retained; waiver visible separately |
| Calendar meeting planned, then canceled | No completed friendship interaction |
| One confirmed interaction in a complete quarter | Quarterly commitment met |
| One workout imported from two providers | One completion after identity reconciliation |
| Three distinct completions in one complete local week | Weekly commitment met |
| Daily window spans a DST transition | Correct local day boundaries |
| Threshold changes after a closed reporting window | Historical result uses its pinned definition version |

This document defines expectations only; it does not claim that these fixture
queries, adapters or automated controls have been implemented or run.

## Migration and ongoing cost

| Choice | Incremental cost | When justified |
| --- | --- | --- |
| Plain edge | One relationship record; basic traversal; temporal edges already supported | No separately managed relationship identity needed |
| Two-person relator | One node plus two participant edges; completeness/uniqueness validation; optional derived view | Independent relationship/commitment identity matters |
| ControlCommitment | Relator plus a versioned rule and scope; acceptance and amendment history | Someone accepts a measurable policy |
| Materialized obligation | Per-trigger record, idempotency key, assignment/disposition and evidence references | A case needs individual workflow or exception handling |
| Derived recurring windows | Evaluator/query work without a graph node for each tick | Routine cadence can be computed from commitment and events |
| Historical evaluations | Versioned facts, source watermarks and correction history | Reproducibility and trustworthy time-based reporting |

The largest recurring costs are identity reconciliation, reliable evidence,
source coverage, time-window semantics and policy changes, not the extra two
edges. Relators additionally require complete atomic batches, participant
validation and temporal deduplication. Current Wiki graph validation inspects
broad graph snapshots; do not assume constant-time writes or quote unmeasured
latency/storage savings.

### Edge to relator

1. Inventory edges by type, orientation, validity, evidence and consumers; run a
   dry-run audit for missing participants, overlapping episodes and duplicates.
2. Define the relator, participant slots and a derived edge view. Preserve the
   old association's meaning and specify new identity/episode rules explicitly.
3. Map each eligible old edge to a stable new relator ID. Preserve original IDs,
   provenance and validity in a migration mapping/receipt; do not pretend the
   original edge became a node with the same record identity.
4. Create complete relator/participant batches idempotently. Retain the old
   records while reconciling counts and evidence. Existing assertions reference
   an exact subject type, ID and revision: copying evidence does not transfer
   member confirmation. New subjects require fresh confirmation where needed.
5. Move readers to one canonical relationship view and switch writers once.
   Archive old edges only after equivalence checks, so consumers never count
   both old edges and derived relationships as separate facts.

Wiki does not currently ship a general migration/alias tool that performs these
steps. Small uncontested graphs are a moderate data-and-reader migration; large
or inconsistent graphs, exact-revision assertions and external IDs make it high
risk. Preserve original records for rollback rather than silently deleting them.

### Relator to edge

A lossless collapse is possible only if two participants and a predicate carry
all required meaning, with no independent workflow, extra participants or
unrepresented attributes. Otherwise the simpler edge is a **view**, not a
replacement. Keep historical relators and evidence accessible. This asymmetry
is a reason to give real commitments identities early, while leaving incidental
associations as edges.

## Staged implementation, if the pilots are accepted

1. Keep this document and examples reviewable; settle “addressed,” trigger
   boundary, source coverage, timezone and who accepts/amends each commitment.
2. Implement deterministic in-memory fixtures and evaluation rows before source
   connectors or live governance actions. Prove the acceptance matrix and
   aggregation grain with a tiny SemLang/Malloy export experiment.
3. Adopt only the relator definitions the fixtures need. Audit existing graphs
   before enabling contracts; leave authored records and ownership intact.
4. Add read-only source samples with provenance and an explicit review UI.
5. Add reminders/escalation only after the user approves actual execution scope.

No board, production PostHog project, personal calendar, workout feed or outbound
notification is activated by this design.

## References and current implementation boundary

- [SemLang concepts](https://github.com/Unsupervisedcom/semlang/blob/main/docs/semlang-concepts.md): identity, grain, relators, events and situations.
- [Wiki relators and assertions](relators-and-assertions.md): atomic participant batches, symmetry, validity, derived views and exact-subject confirmation.
- [Wiki endpoint contracts](ontology-contract.md): read-only audits and write validation.
- [SemLang integration notes](semlang.md): the adapter remains future work.
- [Governance control implementation](../../governance/src/lib/decision-control.ts): current controls and occurrences are organization-oriented and specific to existing decision workflows. This is not a general personal-goal or PostHog response-control engine.

Wiki currently supports kind/relator/assertion stereotypes, not the complete
SemLang concept system. Events and situations in this design can remain typed
source/evaluation data until an adapter and ownership model are implemented.

## Implemented structured-definition boundary

The two seeded controls now use the ControlDefinition JSON body schema instead
of prose as their canonical measurement representation. Each body declares typed
inputs, grain keys, parameters, calendar/elapsed windows, explicit evidence rules,
and ordered, typed operator programs. SQL previews are generated from these
programs and executed against fixtures. They are not a live evaluator.

Graph requirements use stable Wiki type IDs, directions, allowed endpoint types
and minimum distinct matches, anchored on the control. They resolve against the
current owner-scoped Wiki and report missing connections. PostHog has a
`control_source` edge to its Product; the personal pilot intentionally has no
selected source Product yet. Both have null executable source relations. The UI
reports those unbound sources separately from graph completeness.

This is a versioned input representation for a future SemLang/Malloy adapter;
no compatibility with either compiler is claimed. That adapter must also bind
and verify source relations, check grain/joins and units, implement window and
evidence normalization, and run the fixture acceptance matrix against generated
queries. A resolved graph is insufficient to activate a control.
