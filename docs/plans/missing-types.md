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

### 2. Onto answers at staging time

The staging receipt already carries `validation` and `instructions`
(`REPAIR_CHANGES`). Add advisory findings beside them, computed by plain
checks over the draft, no model call:

- `type.generic-cluster`: three or more created nodes of a catch-all type
  (`Document`, `Entity`) that share a parent through the same edge type, or
  whose titles share a pattern (leading numbers, a common suffix, a unit in
  brackets). The Sunny batch trips this three times: shots, concepts, references.
- `edge.generic-cluster`: one edge type used between the same pair of
  catch-all types more than a handful of times (`part_of` Document → Document, 26 times).
- `property.in-title`: a number-plus-unit or ordinal repeated across sibling titles.

Each finding names the records and says what to consider: "12 Documents
under 3 parents look like one kind of record with an order. Consider
proposing a type." It comes with instruction code `CONSIDER_TYPES`, marked
not required. The agent decides: propose types, or restage with a `reason`
saying why Documents are right. Nothing is blocked.

The steward's batch review gets the same rule names so a member sees them on
the Changes page if the agent ignored them.

### 3. New types are proposed in the org's own graph

The agent proposes `graph-type` operations in the same batch, so the member
reviews the vocabulary and the records together. Types start local to that
organization. Promotion to the standard types is a separate, human decision.

For Sunny that would be roughly: `Storyboard` (duration, format), `Shot`
(order, beat, duration), `shot_of` (Shot → Storyboard), `uses_reference`
(Shot → Document), with briefs and references staying Documents. The names
are the agent's to propose and yours to approve; this list is an example,
not a decision.

### 4. Evals

Two fixtures in webapp `evals/outfitter/evals/`, run by agent-eval as today,
starting from the existing organization checkpoint:

- **`onto-new-concept-types`**. Prompt: "Plan two 15-second launch videos for
  our sensor, each with four shots, and save them to Onto." Assertions: the
  batch proposes at least one node type and one edge type with endpoints;
  no shot is a `Document`; order and duration are properties, not title
  text. Judge: are the proposed types sensible and minimal.
- **`onto-questions-not-records`**. Prompt: "Review our Onto records and
  raise anything unclear." Assertions: no `Question` nodes staged; open
  points appear as batch questions or Planning issues.

Run both now to record the failing baseline, then after each change. That
shows whether the instruction alone (step 1) is enough or the receipt
advice (step 2) is needed.

## The Sunny batch

It is committed, so it needs a follow-up batch: create the types, recreate
the 18 concept and shot records under them, move their edges and archive the
Documents. Worth doing only after the types are agreed.

## Decisions for Nicholas

1. Advice only (agent decides), or should a generic cluster block submit?
   Recommended: advice only.
2. Org-local types first, promoted to standard by you later?
3. Redo the Sunny video records once types exist?
4. Build order: evals first for a baseline, then the instruction, then the
   receipt advice. Agree?
