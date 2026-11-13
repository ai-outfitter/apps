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
| Records from outside | `graph_nodes.externalKey` (`<host>/<table>:<id>`) | One stable key per outside thing, so two runs don't create it twice |

Missing: a list of gaps (the audit finds rule breaks, not "Sunny has three
competitors with no products"), and a hosted runner that can read the web.

## Prior art

- **Wikidata bots**: a named account with a declared task, a rate limit, a
  summary on every edit and a reference on every claim. Here: a named batch
  `source`, a proposal budget, a `reason` and evidence per proposal.
- **Wikidata Recoin**: list what most peers of the same type have and this
  item lacks. This is the gap finder, with no model call.
- **Wikidata `reference URL` + `retrieved`**: every claim keeps its URL and
  read time so it can be re-checked (Planning's `sources[].observedAt`).
- **Deep research agents**: plan, read widely, write once with citations.
  A run writes one batch at the end.

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

Gaps stay within 2 hops of the root, so research grows outward from what the
organization cares about.

### 2. Gaps become Planning research work

Agents decide what to do from Planning, so a gap does not trigger research
directly. The audit files the top gaps (at most 5 a day per organization) as
Planning research items through `RouteIntake` with kind `research`, in the
standing records-upkeep project [agent-questions.md](agent-questions.md)
already proposes. A member can also file one by hand.

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
- prefer an existing type; propose a new one only per missing-types.md.

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

App inference cannot browse today. But the platform already reaches a
provider's hosted MCP server through a connector (`ConnectorMcp` in
`webapp packages/connector-core/src/mcp.ts`, used by GitHub): the connector
names the server URL and the allowed tools, and the platform runs every call.
So a hosted search MCP is a connector, not a new subsystem.

Hosted search MCP servers checked on 2026-11-13:

| Server | Hosted? | Key | Notes |
| --- | --- | --- | --- |
| **Parallel Search** `https://search.parallel.ai/mcp` | Yes, by Parallel | None (a key raises rate limits) | `web_search` + `web_fetch`, results ~25k chars per call. Tried from a cloud session with no key: initialize and a search both worked. In the Claude connector directory |
| Brave Search (`brave/brave-search-mcp-server`) | No first-party host; stdio or self-hosted HTTP. Smithery hosts a copy at `server.smithery.ai/brave/mcp` | Brave Search API key, plus a Smithery secret for the hosted copy | Official from Brave |
| DuckDuckGo | No. DuckDuckGo ships no server; community ones (`nickclyde/duckduckgo-mcp-server`) scrape the HTML results | None | Self-host only; DuckDuckGo throttles by IP and the scrape breaks when markup changes |
| Exa, Tavily, Firecrawl | Yes | Provider key | Paid tiers |
| Local Chrome MCP on the workstation | n/a | None | Uses his signed-in browser; only works while the machine is on and only for his agent. Fine for one-off reads, wrong for unattended runs |

Runners:

| Runner | Good | Bad |
| --- | --- | --- |
| **A. A scheduled cloud agent session** (Claude Code on the web trigger) | Exists today; built-in web search plus the Outfitter MCP; no platform change | Tied to one person's account; not an Outfitter workflow run |
| **B. The member's own agent, on demand** | Exists today; how the hardware-workshop research was done | Not automatic |
| **C. An Outfitter workspace with Chrome MCP** (Nicholas, 2026-11-13) | Already proven: the workspace runtime ships Chrome and Chrome DevTools MCP, verified with a real model in AWS nonprod (webapp `docs/workspace-browser.md`, `docs/workspace-browser-poc.md`). A Kubernetes pod per task, isolated browser profile, run history and artifacts on the platform | Nonprod network policy allows only localhost, DNS and the gateway, so public egress must be opened; the Pi built-in MCP change is not redeployed; app workflows can't dispatch a browser step yet |
| **D. A hosted workflow with a `web-search` connector** on Parallel's MCP | Plain workflow, no pod | Workflow inference must be allowed to call connector tools (today it is a plain generate) |

Chrome DevTools MCP reads and clicks pages but has no search of its own.
Driving a search engine's page from a headless browser hits captchas, so the
workspace pairs Chrome (read the page, including ones that need JavaScript)
with Parallel's search MCP (find the pages).

Recommended: **C.** It reuses the workspace runtime instead of a new
connector, and a research item becomes an ordinary workspace task. Steps, in
the order `workspace-browser.md` already lists: redeploy the runtime with Pi's
built-in MCP; open public HTTPS egress for research workspaces only; add
Parallel's MCP to the workspace MCP config; give the task the Outfitter MCP
so it can `ClaimWork`, stage the batch and `RecordResult`. Until then, A runs
the Sunny pilot.

## First pilot

Sunny's competitors. The competitor research already done by hand is the
reference answer: run the loop on a copy of Sunny's graph without it and
compare.

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
2. Runner: an Outfitter workspace with Chrome MCP plus Parallel search
   (recommended), with a scheduled cloud session for the pilot meanwhile?
   Public egress for research workspaces is the change that needs a go.
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
4. Run the Sunny pilot, compare with the hand research.
5. Workspace runner: redeploy, research egress, Parallel MCP in the workspace config.
