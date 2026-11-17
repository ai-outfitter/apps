# Research context: Wiki artifacts and Onto assertions

Status: implementation guidance and proposed acceptance criteria, not a deployment
claim. Inspected apps baseline: 77caa54. This extends the platform's
[knowledge graph architecture](https://github.com/ai-outfitter/webapp/blob/main/docs/architecture/knowledge-graph.md)
and [graph providers](graph-providers.md), not a new knowledge service.

## Ownership

| Concern | Owner | Durable output |
| --- | --- | --- |
| Bounded question, goal, budget, stopping criteria, conclusion | Planning | Discovery record and reviewed result |
| Narrative, context, report, transcript, evidence presentation | Wiki | Document and immutable revision; generated sections separate from authored content |
| Identity, types, relationships, sourced reusable assertions | Onto | Nodes/edges, evidence, and attributable policy/review history |
| Scheduled collection and synthesis | Forerunner | Run provenance and links to saved artifacts/proposals |
| Code experiments, notebooks, eval runs | Producing app / Foundry | Versioned artifacts and run evidence linked back to Planning |

An ontology defines types and relationships; a knowledge graph instantiates them.
A database semantic layer can map those concepts to joins/measures without making
Onto a SQL engine. NVIDIA Auto Ontology is a useful comparison, not a reason to
replace document storage or duplicate analytical execution in Onto.

## Existing implementation and gaps

- Wiki's `src/documents/store.ts` owns revisions and publication. Its `entity/[id]`
  page already reads an Onto entity and creates a Wiki page with an entity reference.
  Keep `outfitter/wiki-map` and legacy routes; do not rename storage or IDs.
- Onto's steward prompt still uses historical Wiki terminology. The accompanying
  small prompt clarification distinguishes document references from report bodies
  and subject descriptions from request provenance. It adds no new approval path.
- `apps/onto/src/server/batch-review.ts` binds results to the batch content digest
  and review job. Reuse that mechanism; do not approve an edited batch using an old
  review. Existing steward approval of clean operations is policy, not proof that
  a member has reviewed every assertion. UI must identify the actual reviewer.
- Forerunner research reports already record sources, owner, installation, run ID
  and capture time. Extend that existing workflow rather than adding an autonomous
  research daemon. Publication and graph approval are independent transitions.
- Planning discovery already has a reviewed result lifecycle. Draft PR #220 adds
  a bounded research brief/evidence contract; integrate there after review, rather
  than introduce a competing Research entity/service. PR #157 is the related plan.
- Webapp `native/iOS/Sources/WebShell.swift` is a WKWebView wrapper. App-level web
  changes carry into iOS; no parallel native graph store or publication rules are
  justified. Native navigation and narrow-screen acceptance still need device tests.

## Concrete journey: interview to product hypothesis

Use synthetic examples in tests; actual interview transcripts stay in their
explicitly authorized organizational scope.

1. Save the interview report in Wiki, preserving source URL, capture time and exact
   revision. Keep consent/access restrictions and quoted statements distinct from
   the summarizer's interpretation.
2. Propose an attributed observation: "Engineer A reported spending two hours
   reviewing agent output in the last release." Reference the precise source
   revision/excerpt; do not turn it into "all engineers lose two hours."
3. Reuse an existing Problem if appropriate: human review limits agent throughput.
   Link the observation as supporting evidence, retain contrary observations and
   mark the generalization as a hypothesis. Do not invent a relationship type if
   an existing declared type fits.
4. Link a proposed UserStory addressing that Problem: a reviewer needs a concise
   evidence packet. Product relevance is a proposed opportunity, not a promised
   product feature or customer commitment.
5. Planning asks a bounded question: can a review packet reduce median review time
   while maintaining defect detection? Record baseline, population, method, budget,
   quality guardrail and stopping criterion. A spike is the timeboxed investigation.
6. Save result artifacts in Wiki/producer storage, link them to Planning, and stage
   reusable conclusions in an Onto batch. Apply the current authority policy to the exact revision/digest; routine
   eligible assertions may be accepted automatically, with later human review. Inconclusive and disproven hypotheses are valid.

The reader must be able to follow story → problem → attributed observation →
source revision, and back. A reference never grants access: restricted sources
must fail closed without leaking excerpts, titles or contents to unauthorized users.

## Quiet background preparation, explicit authority

Collect only from configured/authorized sources under the original owner scope.
Use existing workflow run identities, leases, idempotency receipts and schedules.
Bound the work by time/cost and source coverage; record partial failures and stale
inputs. Repeated runs should link or update a draft, not duplicate people/problems.

Target: background agents continuously submit authorized evidence and relationships,
with most routine batches ingested automatically under explicit policy. Human review
is an exception and a later quality-control mechanism, not a universal precondition.
Current behavior must still follow deployed governance. Agents may prepare draft
artifacts and change proposals through those existing APIs. Keep generated
sections separate; never overwrite authored or published prose silently. Requests
and instructions belong in provenance/Planning, not in canonical descriptions.
Retain evidence of who initiated the work separately from who executed/reviewed it.

Do not equate "generated", "saved", "published", "reviewed" and "verified".
Display document publication independently of assertion review and source freshness.
Follow configured app-owned policy; unavailable/stale policy fails closed. Automatic graph ingestion does not automatically publish a Wiki report. Implement
any expanded auto-ingestion policy explicitly and test it; do not silently bypass
current governance.

## Small web/iOS follow-ups (not implemented in this change)

- Wiki: readable report first; visible generated/draft/publication state, source
  coverage and related entities; explicit "Propose graph changes" rather than
  silently extracting assertions while editing prose.
- Onto: concise identity, structured relationships, assertion evidence and review
  state; "Read report" opens its Wiki reference rather than a copied graph body.
- Home: show a useful finding or a review request with source/run links, rather
  than every background artifact. Never run inference on page load.
- On iOS test the same journey with readable source links, back navigation and
  keyboard/touch review controls. No new native domain model needed.

## Acceptance and evaluation

Evaluate both positive and negative cases with the existing reviewer/research eval
infrastructure: subject description contaminated by request narration; legitimate
Person biography; attributed observation; report body stored as a graph description;
contradictory interviews; stale revision; unreadable source; repeated run; changed
batch after review; missing evidence yielding an inconclusive result. A prompt text
check alone is not evidence the reviewer reliably catches these cases.

First deliver one synthetic interview journey end to end. Measure correct source
attribution, false-positive review rate, duplicate rate, preserved authored text,
access-denial behavior, latency, tokens/cost and time to review. UI/live inference
acceptance remains separate from unit tests and from successful deployment.

## Continuous ingestion and later review: target policy

Reuse Onto's existing batch review, content digests, assertion history and scheduled
workflows. No second ingestion database or approval service. Before enabling new
sources, verify current organization membership, connector selection, source ACLs
and explicit sharing consent. Access to a personal mailbox is not permission to
copy it into an organization graph. Calendar participation is not sharing consent.
Treat inbound messages as evidence, never instructions to change policy or execute
an action. Source selection and source text cannot enlarge the agent's authority.

Suggested policy tiers (design proposal, not implemented):

- Automatically ingest low-risk, attributed observations and supported relationships
  when source scope, type contract, duplicate handling and provenance checks pass.
  Record the policy version and execution/reviewer identity; label automatic
  acceptance distinctly from human confirmation and independently verified truth.
- Route ambiguity, conflicting identities, unsupported generalization, sensitive
  content, uncertain sharing, schema changes and consequential relationships to an
  exception queue. Ingestion may preserve a disputed observation without promoting
  it to an uncontested canonical conclusion. Do not invent partnerships to connect
  a research reference to the owner.
- Review accepted batches later through sampling, disagreement alerts and explicit
  member requests. Link a disagreement to the assertion/version and competing
  evidence; do not silently overwrite it or resolve it by majority mention count.
- Correct through existing versioned edits/retractions/superseding assertions and
  auditable receipts. Preserve the old evidence and decisions subject to retention
  policy. Investigate whether selective batch rollback exists before promising an
  undo button; dependent summaries should be marked stale or regenerated as drafts.
- Revoked/deleted source access must block retrieval immediately through existing
  authorization. Define retention/redaction and derived-claim invalidation policy
  before treating captured text as a permanent unrestricted archive.

Additional evals: repeated Slack message with stable source ID, edited email/thread,
revoked connector access, personal-to-org disclosure, conflicting observations,
malicious instructions inside source text, automatic accept followed by correction,
and policy revision during a run. Measure automatic acceptance rate alongside
false acceptance, exception workload and time to correct; throughput alone is not
success. The accompanying [installation ownership fix](../apps/onto/docs/installation-ownership.md)
separates trusted scope from relevance without inventing relationships. It remains
a local, undeployed change; expanded ingestion policy still requires explicit work.


## Root-connected context

Both personal and organization knowledge should generally reach the canonical root
through real relationships or research-context paths. Installation scope identifies
whose graph this is; it does not itself constitute a graph edge. Default batches
use the existing account-linked Person or exact host-bound Organization. Explicit
anchors add narrower context constraints; a source citation alone is not a graph path.
A report owned by the organization can document an external vendor without asserting
a partnership. Preserve stored anchors and repair missing context paths, rather than
clear connectivity constraints merely to make review pass. Missing or ambiguous
root bindings allow staging but block submission and approval until a canonical
root has been established.

### Enforcement update

Owner-root connectivity is mandatory for created nodes in batch ingestion, in
addition to any saved context anchors. Empty anchors cannot opt out. Missing or
ambiguous roots allow draft staging but require editor bootstrap before submission
or approval; the system does not manufacture an owner entity or semantic relation.
Existing authorized direct graph APIs and editor identity-linking APIs remain the bootstrap/repair path. See Onto's
installation-ownership document for compatibility and remaining boundaries.
