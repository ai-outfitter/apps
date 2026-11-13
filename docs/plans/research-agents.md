# Research agents that grow Onto

Status: exploration, nothing built. Companion to [Where agent questions go](agent-questions.md)
and [When an agent brings a new kind of thing](missing-types.md). Asks for decisions before any code.

> Let's start a thread exploring how automated research can automatically
> explore and expand the Onto graph. (Nicholas, 2026-11-13)

## The idea in one paragraph

A research agent works a loop: **find a gap** in an organization's graph,
**claim** it as research work, **read** outside sources, **stage** what it
learned as one small Onto batch anchored to the organization, and **record**
the result with its sources. Almost every piece already exists. What is
missing is the first step (Onto saying where its graph is thin) and a runner
that can actually read the web.

## What already exists

| Piece | Where | What it gives research |
| --- | --- | --- |
| Change batches with anchors | Onto `ChangeBatchChanges` | Staged writes invisible until commit; every new node must reach an anchor |
| Confidence policy + review window | Onto batches, used by Forerunner discovery (`autoAcceptThreshold = 0.95`) | Proposals at or above 0.95 land without review; the rest commit at end of day unless a member rejects |
| Steward review | `apps/onto/agent/ontology-steward.md`, `batch-review` workflow | Owner reachability, duplicates, overstated claims, foreign projects, type mismatch |
| Scheduled audit | `ontology-audit` workflow (daily 08:00) | Already walks the graph; today it only reports findings |
| Research work items | Planning `RouteIntake` (kind `research`), `ClaimWork`, `RecordResult` | A claim token, a result with `sources[{url, observedAt, excerpt}]`, `gaps`, `wikiRefs`, and Governance review |
| Research gate | Governance `work_gate` control, `evidence_requirements.researchCitations` | An organization can require citations before research counts as done |
| Explorations | Onto `/explore`, `MutateExploration` | A member and an agent walk paths (`offerings`, `competitors`, `projects`); empty steps show where nothing is known |
| Sharing | Onto `Share` | What one organization's research may show another (Artera → Sunny supply) |
| Records from outside | `graph_nodes.externalKey` (`<host>/<table>:<id>`) | One stable key per outside thing, so two runs don't create it twice |

What does **not** exist:

- **No hosted runner can read the web.** App inference
  (`webapp src/lib/workflow-app-inference.ts`) is a plain generate call with no
  tools and a 64 KB step cap. There is no web search or fetch connector in
  `packages/connector-*`. Forerunner reads only the member's own connected
  accounts.
- **No list of gaps.** The audit finds rule breaks, not "Sunny has three
  competitors with no products recorded".

## Prior art outside Outfitter

| Prior art | What to borrow |
| --- | --- |
| Wikidata bots and the bot approval process | A bot is a named account with a declared task, a rate limit, an edit summary on every change and a reference on every claim. Our version: a research run is a named batch `source`, a per-run proposal budget, a `reason` and evidence per proposal |
| Wikidata Recoin ("relative completeness") | Compare an item with others of the same type and list the properties and relations most of its peers have and it lacks. This is the gap finder below, with no model call |
| Wikidata `reference URL` + `retrieved` | Every outside claim carries the URL and when it was read, so it can be re-checked later. Planning's `sources[].observedAt` already has this |
| Deep research agents (Anthropic, OpenAI, Stanford STORM) | Plan questions first, read many sources, then write once with citations. The run writes one batch at the end, not as it goes |
| Active learning | Ask people only where the agent is unsure. Maps to the confidence policy: sure claims land, unsure ones wait or become batch questions |
| PROV-O / nanopublications | A claim, its source and the activity that produced it are kept together. Batch evidence + batch source + run id already form this triple |

Nothing here needs a new store or a new graph format.

## The loop

### 1. Find gaps (Onto, no model call)

The daily `ontology-audit` gains plain gap checks beside its rule checks.
Each gap is a short line with the node, what is missing and why it matters.

| Gap | Example | How it is found |
| --- | --- | --- |
| `peer.missing-relation` | `Organization:ecowitt` is a competitor with no `Product` | Recoin-style: most nodes of this type and role have this edge, this one doesn't |
| `peer.missing-property` | 4 of 6 competitor products carry `price_usd`; two don't | Same, for properties |
| `path.empty` | Exploration step `competitors` from `Product:snsp-1` returns nothing | Saved explorations whose steps reach zero nodes |
| `evidence.stale` | A `customer_of` edge cites a page read 200 days ago | Oldest `observedAt` past an age per edge type |
| `organization.unrelated` | Already a steward check | Reused as a gap: research the relationship |

Gaps are bounded to the owner's neighbourhood (within 2 hops of the root by
default), so research grows outward from what the organization cares about
and never wanders across the open web.

### 2. Gaps become Planning research work

Agents decide what to do from Planning, so a gap does not trigger research
directly. The audit files the top gaps (at most 5 a day per organization) as
Planning research items through `RouteIntake` with kind `research`, in the
standing records-upkeep project [agent-questions.md](agent-questions.md)
already proposes. A member can also file one by hand ("find Sunny's
competitors' prices"). Either way the queue is visible, assignable and
can be closed without anyone opening Onto.

### 3. A research agent claims and reads

The agent calls `ClaimWork`, gets the item's context (the gap, the node's
neighbourhood as addresses), searches and reads sources, and keeps a draft
under its claim. Run limits, fixed in the agent's instructions:

- at most 10 sources read and 25 proposals per item, so the steward can read
  the whole batch in one pass (the 64 KB cap in missing-types.md);
- only records within 2 hops of the gap's node;
- an evidence quote is the sentence that supports the claim, with URL and
  `observedAt`;
- outside things get an `externalKey` from a stable public id where one
  exists (see decision 4), so the same company is not created twice;
- read the types first; prefer an existing type, propose a new one only per
  missing-types.md.

### 4. Stage one batch, record the result

- One batch per research item: `source: {kind: "research-run", ref: <item id>}`,
  anchored to the root node, `reason` per proposal.
- Policy `confidence` 0.95 with an end-of-day window, the same as Forerunner
  discovery. For the Onto sharing pilot (Artera, Sunny, Outfitter) the agent
  submits and approves its own batches, as Nicholas asked on 2026-11-10.
- A point that blocks a proposal goes on the batch as a question; anything
  else goes back to Planning as a new research item. No `Question` nodes.
- `RecordResult` closes the item with `sources`, `gaps` left over and
  `wikiRefs` to the batch's records. Where the organization has a Governance
  `work_gate`, that review runs as it does today.

### 5. Keep it fresh

`evidence.stale` gaps re-open research on old claims. Re-checking a claim
either refreshes `observedAt` on the same edge, or stages its archive with
the new source as evidence. Nothing is deleted.

## Who runs the agent

The hosted platform cannot browse, so today the researcher is an outside
agent with web search and the Outfitter MCP. Three ways, cheapest first:

| Runner | Good | Bad |
| --- | --- | --- |
| **A. A scheduled cloud agent session** (Claude Code on the web trigger, in the environment that already allows ai-outfitter.com) | Exists today; has web search and the MCP; runs as Nicholas's agent connection; no platform change | Tied to one person's account and token; not visible as an Outfitter workflow run |
| **B. The member's own agent, on demand** | Exists today; how the hardware-workshop research was done | Not automatic |
| **C. A hosted research workflow** with a new web search/fetch connector | Runs as an Outfitter workflow with runs, schedules and Pause; works for any member | A new connector, provider key and inference with tool calls; the most work |

Recommended: **A now, C only if A proves the loop is worth it.** A needs no
new app actions, only the gap checks and the agent instructions.

## First pilot

Sunny's competitors. The research already done by hand
(`/mnt/project-files/hardware-workshop/research/sunny-competitive-research.md`)
is the reference answer: run the loop on a copy of Sunny's graph without
it, and compare what the agent finds.

## Evals

In `apps/onto/evals/`, next to the missing-types evals, recorded as a failing
baseline first:

- **`onto-research-fills-gap`**: a Sunny-shaped fixture with two competitors
  lacking products. Assert: one batch per item, every new node reaches the
  root with no extra anchors, every proposal has a URL and `observedAt`, no
  `Question` nodes, no new `Document` used for a product.
- **`onto-research-stays-near`**: assert nothing staged is more than 2 hops
  from the gap's node.
- **`onto-research-no-duplicates`**: run twice; the second run creates no
  node whose `externalKey` already exists.

Sources are served from fixtures so the evals do not depend on the live web.

## Decisions for Nicholas

1. Work queue: gaps become Planning research items (recommended), or the
   agent reads gaps straight from Onto?
2. Runner: a scheduled cloud agent session now (recommended), or build the
   hosted web connector first?
3. Approval: outside the pilot orgs, research batches use the 0.95 policy with
   an end-of-day window, like Forerunner discovery?
4. Outside identity: use Wikidata ids as `externalKey` for organizations and
   products (`wikidata.org/entity:Q95`) where one exists, falling back to the
   company's domain (`web/domain:ecowitt.com`)?
5. Pilot: Sunny competitors first?

## Build order, after a go

1. Evals with the failing baseline.
2. Onto: gap checks in `ontology-audit`, written as Planning research items.
   One PR.
3. Research agent instructions (a prompt file next to `ontology-steward.md`)
   and the scheduled session. One PR plus the trigger.
4. Run the Sunny pilot, compare with the hand research, then decide on C.
