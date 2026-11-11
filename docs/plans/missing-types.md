# When an agent brings a new kind of thing

Status: proposal, nothing built. Companion to [Where agent questions go](agent-questions.md).

## What happened

An agent planned Sunny's launch videos and wrote batch `16451514`
("Sunny launch videos — app, sensor and microgreens"). It is committed: 82
records, every node a generic `Document`.

| What the agent made | Count | Stored as | Real shape hidden in titles and edges |
| --- | --- | --- | --- |
| Launch packet | 1 | Document | the campaign |
| Product brief (app, sensor, microgreens) | 3 | Document, `part_of` the packet | one per product |
| Video concept, 15s or 30s ("Find your spot (15s)") | 6 | Document, `part_of` a brief | duration is in the title |
| Shot ("01 — Hook — choose a place / sunny-app-find-your-spot-15") | 12 | Document, `part_of` a concept | order, beat and parent are in the title |
| Production reference ("SNY-1 rev A visual lock") | 5 | Document, `documents` from shots | "a specification, not an uploaded asset" |

Only two edge types carry all of it: `part_of` and `documents`, both between
Documents. Nothing can ask "the shots of this storyboard in order" or "every
15-second concept for the sensor" without parsing titles.

## Why the agent did it

- `Document` is the catch-all: "written context that needs its own stable
  identity". Everything fits, so nothing pushes back.
- No instruction says to look for a missing type. `ChangeBatchChanges` says
  "Stage additions durably". The MCP server instructions say nothing about
  types. Batches can create types (`graph-type` operations), but the agent is
  never told that proposing one is welcome.
- Onto never answers. Staging returns `validation` (endpoint and anchor
  errors) only. The steward's `type.mismatch` check runs after submit, by
  which time this batch had committed.

## The common thread with questions

Both problems are the same gap: **a batch is one-way.** The agent pushes
records; nothing comes back until a member looks. The fix in both cases is
to make the batch a short conversation that ends before anything is saved:

- agent → member: questions on the batch ([agent-questions.md](agent-questions.md));
- Onto → agent: advice in the staging receipt (this document).

## Proposal

### 1. Tell the agent, in the tool it already reads

`ChangeBatchChanges` description and the Outfitter MCP instructions gain one
rule:

> Before staging, read the types. If three or more records you are about to
> create share a shape that no type names (an order, a duration, a stage, the
> same parent), propose the type and its relationship types in the same
> batch, with endpoints. `Document` is for prose, not for records.

### 2. Onto reviews the draft while it is still open

Today the steward reviews only after submit. Move the review earlier, so the
agent hears back while it can still change the batch.

- **Every staging call** returns plain checks beside `validation`, with no
  model call:
  - `type.generic-cluster`: three or more created nodes of a catch-all type
    (`Document`, `Entity`) that share a parent through the same edge type, or
    whose titles share a pattern (leading numbers, a common suffix, a unit in
    brackets). The Sunny batch trips this three times: shots, concepts, references.
  - `edge.generic-cluster`: one edge type used between the same pair of
    catch-all types many times (`part_of` Document → Document, 26 times).
  - `property.in-title`: a number-plus-unit or ordinal repeated across sibling titles.
- **The steward's model review runs on open batches too.** Review jobs are
  already keyed by a digest of the batch content (`onto_review_jobs`), so an
  open batch is reviewed once per distinct draft, not once per call. The
  agent reads `review` on the batch before it submits.
- **Onto proposes the type, not only the complaint.** A missing-type finding
  carries a `fix` the agent can stage as it is: the `graph-type` operations
  (node type with properties, edge types with endpoints) and which staged
  records should move to them. The agent accepts it, changes it or restages
  with a `reason` for keeping Documents. The steward still writes nothing itself.
- Instruction code `CONSIDER_TYPES`, not required. Nothing is blocked.

Making any of this binding (hold a batch until its review is clean) is the
Governance control already sketched in `apps/onto/docs/batch-review.md`,
adopted per organization. Not part of this plan.

### 2a. A root node, and anchors that default to it

Agents keep choosing anchors nobody asked for. What matters almost every
time is one thing: each new record reaches the owner.

- Onto gets a first-class **root node**: the Organization bound to an
  organization's Onto, the person for a personal Onto. The steward already
  finds it (`ownerOf` in `batch-review.ts`, organizations only); make it a
  stored fact of the installation, exposed to agents in one read.
- **Every batch is anchored to the root by default.** An agent passes no
  anchors and each new node must still reach the root through saved or
  staged relationships. `owner.unreachable` becomes a staging check instead
  of an after-the-fact audit finding.
- Extra anchors stay possible for narrow work, but the tool description stops
  advertising them: "Batches are anchored to the root. Add anchors only when
  the member asks for a narrower scope."
- An Onto with no root bound reports that as the first staging finding, as
  the steward does today.

### 3. A domain's types belong to the app for that domain

Decision (Nicholas, 2026-11-10): the platform does not hold marketing types
or their evals. An app does.

- Storyboards, shots and the relationships between them are declared by the
  marketing app, the way Creative team already declares `BrandInterview`
  and its four relationship types (`apps/creative-team/src/server/wiki.ts`):
  fixed IDs, added to the organization's Onto add-only on first use, written
  through a change batch.
- An agent asked for launch videos uses that app's documents, which stage
  typed records. If the app is not installed, Onto's review should say so:
  "these look like storyboards; the Creative team app has types for them."
- Onto's job stays generic: notice a cluster of look-alike catch-all records,
  and point at an installed or installable app that owns the shape. Only when
  no app owns it does the agent propose org-local types in the batch.
- Which app: extend Creative team (today a personal-brand app that already
  drafts video scripts) or a new dedicated marketing app. Open, see below.

### 4. Evals

The evals live with the app that owns the types, as Forerunner's and
Planning's already do (`apps/<app>/evals/`). The platform keeps only the
runner: starting a disposable Outfitter, seeding a graph, letting Onto's
review run on a real model, recording the calls. The first version of these
fixtures is in webapp#904 and moves to the app once it is chosen.

Recreate this exact scenario and check that Onto notices the missing type
and proposes it:

- **`onto-new-concept-types`**. Prompt, as the member gave it: plan launch
  videos for the organization's products, each with a storyboard of shots,
  and save them to Onto. Assertions:
  - the batch's review names the missing type and carries a stageable fix;
  - the final batch creates at least one node type and one edge type with
    endpoints, and no shot is a `Document`;
  - order and duration are properties, not title text;
  - every new node reaches the root, and the agent passed no extra anchors.
  Judge: the types are sensible and minimal.
- **Same scenario on separate Ontos.** Each organization has its own Onto,
  so the fixture runs once on a Sunny-shaped graph and once on an
  Outfitter-shaped graph. Both must reach the same conclusion: a storyboard
  type, a shot type and a typed relationship between them. The run reports
  the proposed type names and properties side by side, so drift between
  instances is visible. Type names may differ in wording; the shape may not.
- **`onto-questions-not-records`**. Prompt: review our Onto records and raise
  anything unclear. Assertions: no `Question` nodes staged; open points
  appear as batch questions or Planning issues.

Only the Sunny and Outfitter fixtures are saved in the repo. Artera is not.

Run them now to record the failing baseline, then after each change.

## The Sunny batch

It is committed, so it needs a follow-up batch: create the types, recreate
the 18 concept and shot records under them, move their edges and archive the
Documents. Worth doing only after the types are agreed.

## The Unsupervised batch (added 2026-11-10)

Batch `62527391` ("Confluence engineering export: systems, proposals and
operations", 201 proposals, awaiting review) shows three more problems.

### The steward cannot read a large batch

The review failed with "413 Step data too large" and one warning,
`owner.unknown`.

- **413.** `batch-review.ts` sends up to 300 operations, each with its full
  body and evidence quotes, in one `inference.generate` call. The platform
  caps a step's data at 64 KB (`MAX_DATA` in webapp
  `src/lib/workflow-app-inference.ts`). In this batch one proposal is about
  3 KB, most of it a pasted PDF page, so 201 of them are roughly ten times
  the cap. Any batch past about 20 such proposals fails the same way.
- **Fix.** The steward reads a batch in parts that fit: operations grouped by
  type and neighbourhood, evidence cut to a short quote plus its citation,
  one model call per part, findings merged. The review states how much it
  covered. The built-in checks already run on the whole batch.
- **`owner.unknown`.** Unsupervised's Onto has no single Organization node
  carrying `organization_id`, so every owner check is skipped. The root node
  in section 2a removes this case: the root is a stored fact of the
  installation, set at install or picked once by an editor, not rediscovered
  on each review.

### Too many types is the same fault as too few

Unsupervised's graph already carries a long list of one-purpose types from
earlier agent batches: `DomainConcept`, `DataField`, `DataGroup`,
`LeverParticipation`, `VisibilityRule`, `UseCase`, `DeliveryInterface`,
`AcceptanceCriterion`, `EvaluationRecord` and more, next to a general
`Concept` type this batch uses. Sunny got one catch-all type for
everything; Unsupervised got a new type per idea. The exact batch that
introduced them could not be read back (batch details over about 40
proposals exceed the read budget; another thing to fix).

- The instruction rule in section 1 gains its other half: "Propose a type
  only when several records share a shape the member will query by. Prefer
  one type with a property over several near-identical types."
- New built-in check `type.sprawl`: a batch that creates more than a few
  node types, or a type with fewer than three records, or types whose
  properties and endpoints match an existing type. The fix it carries names
  the type to fold into.
- The steward's review of an open batch judges new types first, before any
  records are read, since everything else depends on them.
- Evals: a third fixture where the right answer is one type with a `kind`
  property, so a run that scores well on launch videos by inventing types
  freely fails here.

### Cards that say nothing

Every card in this batch reads the same. Taking `Scalar Feature`:

- summary: "Scalar feature with an encoding but no index or perspective."
- body: the same sentence under `## Facts`, then a fixed
  `## Evidence and status` paragraph repeated on all 201 cards;
- reason: "PDF page 103 supports this Concept and its facts", a template;
- evidence: a 2 KB run of the PDF page, most of it about other things.

A reviewer cannot tell from the card what the record is for or why it should
exist. Rules for the tool description, each with a built-in check:

- `summary` says what the thing is and why this organization cares, in a
  sentence a member could approve on its own (`card.summary-repeats-body`,
  `card.summary-repeats-title`);
- `body` is only for content beyond the summary; boilerplate shared by
  every card belongs once on the batch (`card.boilerplate`, the same
  paragraph on more than five cards);
- `reason` says why this record and not what the source page was;
- an evidence quote is the sentence that supports the claim, capped in
  length (`evidence.quote-too-long`).

## Reading a batch as pages, not cards

Nicholas, 2026-11-10: the cards are hard to navigate; he wants to open the
page for each item.

- A proposed node opens in the existing node page
  (`src/pages/[nodeType]/[nodeId].astro`) at its future address with
  `?batch=<id>`: same layout, body, properties and relationships as a saved
  node, read from the batch.
- The page marks it plainly: one line under the title, "Proposed in
  <batch title>, not saved", linking back to the batch. Proposed
  relationships and proposed neighbours carry the same mark; saved ones do
  not. An edited node shows the saved page with the proposed changes marked.
- Approve and Reject for that one proposal sit on the page, with its
  evidence, reason, findings and any batch question that names it.
- Next and previous walk the batch in a useful order: types first, then
  nodes grouped by type, with a node's relationships shown on its page
  instead of as separate cards.
- The Changes page becomes the list: one line per proposal (type, title,
  summary, state), each a link to its page. The graph view links to the same
  pages. Explore and node lists can show proposed records with the mark when
  opened from a batch, never otherwise.

## Decisions for Nicholas

1. Advice only (agent decides), or should a generic cluster block submit?
   Recommended: advice only, with blocking left to a Governance control.
2. Which app owns marketing storyboards: Creative team, or a new one?
3. Redo the Sunny video records once types exist?
4. Batch items as pages (above): agree, and should the card list go away
   entirely or stay as the one-line index?
5. Build order: evals first for a baseline, then root node and default
   anchors, then open-batch review with type proposals (reading large batches in
   parts), then batch item pages, then the instruction text. Agree?
