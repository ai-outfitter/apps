# Where agent questions go

Status: proposal, nothing built. Asks for a decision before any code.

## What happened

An agent reviewed Artera's graph on 2026-11-10 and opened batch
`90a34e33` ("Artera Wiki review: governance, measurement and roadmap
follow-ups"). It holds 10 proposals: 5 `Question` nodes and 5 `about` edges,
every edge pointing at `Organization:artera`.

| Question | What it really is |
| --- | --- |
| Do Artera's director assignments resolve to the correct board role? | A data fix (a Governance assignment points at `Role:software-director`), plus a possible bug report on ID collisions |
| How do board quorum and flight-hardware sign-off work together? | A decision for the two directors |
| How will Artera verify progress toward produce grown off Earth and eaten? | Work on a goal: define its metric with the goal owner |
| Which accepted roadmap links the Earth analogue to Artera-1? | A decision for whoever owns the roadmap |
| Which organization catalog suggestions remain outstanding? | Upkeep work for an agent, not a question for anyone |

The reviewer gets two buttons per proposal: Approve or Reject. Approve
saves a question as a permanent node next to Artera's facts. Reject throws
the question away. Neither one answers it, and the Changes page has nowhere
to type an answer.

## Why the agent did it

Nothing told it to, but nothing told it not to, and the ontology invited it:

- **The `Question` type.** The standard types (`packages/app-sdk/graph/standard-types.json`,
  `apps/onto/seeds/types-v1.json`) define `Question` ("an individually
  identifiable unresolved question about an entity or relationship") with the
  agent guidance "Link subjects with about." An agent that finds open points
  and reads the types will do exactly what this one did.
- **No other home.** An agent working over MCP sees Onto's documents and
  `ChangeBatchChanges`. Batches carry proposals, evidence, confidence and a
  reason. They have no place for a question.
- **The steward prompt dodges it.** `apps/onto/agent/ontology-steward.md`
  says to put "needs decision" items "as questions in your report, not in the
  batch". An audit run's report is a workflow output nobody reads on the
  Changes page, so even the steward has nowhere durable to put them.

## How people use the app

- A member finds out about work through the Onto Home card ("waiting for
  review") or a link from an agent, opens the batch on the Changes page, looks
  at the graph and the proposal list, and approves or rejects. They come for a
  few minutes, decide and leave.
- Approval means "this is true about us". A batch is a diff to the graph,
  so everything in it should be a claim the member is willing to sign.
- Questions are a conversation, not a fact. Someone asks, someone answers,
  and the answer changes what gets written. Once answered, the question
  itself has no lasting value in the graph; the answer, cited as evidence,
  does.
- The person who can answer is often not the reviewer (the directors, the
  goal owner). That needs an assignee and a place that person already
  checks, which Onto does not have and Planning does.

## Options

| Option | Good | Bad |
| --- | --- | --- |
| **A. Question nodes (today)** | Already works | Questions get merged as knowledge; approving is not answering; answered questions linger; the reviewer must approve or lose them |
| **B. A Document with a JSON-schema body holding a question list** | Precedent: `Release.openQuestions` (must be empty before commit) | Still a graph record merged through a batch; one shared list nobody owns; answers edit a JSON blob |
| **C. Questions on the batch** | Lives and dies with the change it blocks; answered on the page where the reviewer already is; nothing reaches the graph | Gone when the batch closes, so only right for questions that block a proposal |
| **D. Planning issues** | Exists today, durable, assignable, has status and Ask Outfitter; any member (and their agent) can create them | Every issue needs a project; Artera has only `Artera-1`; issues don't link graph records yet |
| **E. Governance decisions** | Right home for board-level decisions | Sunny has no Governance controls; heavy for a question |

## Recommendation

**Onto holds what is true. Questions are work, so they never become graph
records.** Each question goes to one of two places, chosen by whether a
proposal in the same batch depends on it.

### 1. A question that blocks a proposal: ask on the batch (option C)

The agent stages the proposal it is unsure about, and attaches the question
to the batch beside it.

- Shape, stored as JSON on `graph_batches` like `review` and `anchors`:
  `questions: [{ key, ask, refs, options?, answer? }]`. `refs` names the
  proposals that depend on it; `options` lets the agent offer choices
  (for example "Shen Ge alone" / "both directors").
- Staged through `ChangeBatchChanges` with a new `ask` action, next to
  `stage` and `configure`. Allowed while the batch is open or awaiting review.
- The Changes page shows questions at the top and next to each proposal
  they block. The member answers with a choice or a line of text. Answering
  approves nothing.
- The agent reads answers in `ChangeBatches` (`details: true`), then fixes
  its proposals with `ReviseBatch`, citing the answer as evidence
  (`{ provider: "onto", recordId: "batch:<id>#<key>" }`). The answer outlives
  the batch through that citation.
- The Onto Home card adds "2 questions" to the batch line, so questions reach
  the member through the card they already see.
- An unanswered question does not block approval. The member may decide
  without answering, and the question closes with the batch.

This is the only new piece. It reuses the batch, its page, its card, its
review rights and `ReviseBatch`. Prior art inside Onto: the steward's
per-proposal findings (`graph_batches.review`) and `Release.openQuestions`.

### 2. A question nothing in the batch depends on: a Planning issue (option D)

Follow-ups ("ask the directors", "define the goal metric", "reconcile the
catalog") are work for a person. They go to Planning as issues through
`IssueChanges`, in the project they belong to, assigned to whoever can
answer. The description names graph records by address
(`Organization:artera`, `Goal:…`). Done means answered; the answer comes
back as a normal batch.

When no project fits (board rules are not Artera-1 work), the issue goes in a
standing project for keeping the organization's records right. Whether that
project is created per organization by the agent or by a person is one of the
decisions below.

### 3. Remove `Question` and `about`

Delete both from the standard types and Onto's seeds, the same "no legacy"
cleanup as elsewhere. Forerunner discovery already excludes `Question`. No
importer or app reads them. Live installations keep their copies until a
migration archives them. The questions in this Artera batch are uncommitted;
whether any organization already has committed `Question` records still needs
checking (the Entities read failed when this was written).

### 4. Instruction changes

- `ontology-steward.md`: audit mode puts "needs decision" items on its batch
  as questions (blocking) or as Planning issues (follow-ups), instead of
  "in your report". Batch mode is unchanged.
- `ChangeBatchChanges` description: "Questions go on the batch with `ask`,
  never as records."
- Outfitter MCP server instructions, Changes section: one line saying the
  same, so agents that never read Onto's prompt still learn it.

## The Artera batch

Nothing is decided yet. If this plan is accepted, the cleanest path is to
reject batch `90a34e33` and redo it: the board-role item becomes a proposed
fix (or a Planning issue if the agent can't tell the right role), the board
rules, roadmap and goal metric items become Planning issues for the people
who can answer, and the catalog refresh becomes the agent's own next batch.

## Decisions for Nicholas

1. Accept the two-home rule (batch questions + Planning issues)?
2. Where do org-level follow-ups go when no project fits: a standing
   "Records upkeep" project per organization, or something else?
3. Delete `Question` and `about` outright?
4. Reject and redo the Artera batch as above?

## Build order, after a go

1. Onto: `questions` column, `ask` action, answers on the Changes page and
   Home card, `ReviseBatch` citation. One PR, with before/after screenshots.
2. Remove `Question`/`about` from standard types and seeds; update the
   steward prompt and tool descriptions. One PR.
3. webapp: one line in the MCP server instructions.
