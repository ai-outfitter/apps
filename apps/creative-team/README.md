# Creative team

A one-person creative team for a personal brand, installed personally (or once per
client in an organization). One page agent plays three roles:

- **Brand strategist** — positioning and perception. Runs the onboarding interview
  (the "intellectual signature" questions in `src/lib/brand.ts`) one question at a
  time and proposes the member's answers for the **brand document**.
- **Content strategist** — builds the **content document** from the member's best
  10–20 posts per platform, or from the 5–10 people who shaped their thinking when
  they have not posted yet, then proposes a **content map**: 3–4 pillars, 5–7 topics
  each, 5–10 ideas per topic, 4–5 angles per idea, through the member's lens.
- **Writer** — drafts posts, threads, articles, newsletters and video scripts from
  map ideas and angles, in the member's voice, for the member to rewrite and post.

## Pages

| Page | What it holds |
| --- | --- |
| `/` | Progress through the four steps and what to do next |
| `/brand` | The interview and its answers (`brand_answers`) |
| `/content` | Sources (`sources`) and the voice / ideas / worldview synthesis (`content_profile`) |
| `/map` | The content map tree (`map_nodes`, levels pillar → topic → idea → angle) |
| `/drafts` | Drafts (`drafts`), optionally linked to an idea or angle |
| `/settings` | What the team can and cannot do |

## Data and writes

Working material lives in the installation database (`src/server/schema.ts`): the
interview answers as they are being written, sources, the content profile, the map
and drafts, all edited often and in bulk. Every write is a mutation document
(`src/server/documents.ts`) that pages run through `api/apps/creative-team/<Document>`
and agents run with `graph_mutate`; `*Changes` batch documents wrap them. Reads are
served over `graph.graphql`.

## Knowledge graph

The brand interview goes to the member's Wiki (`src/server/wiki.ts`), always as one
**change batch** they review on the Wiki's Changes page; nothing commits before that.
`StageBrandInterview` (the agent's `creative_team_brand_wiki`) stages:

- a `BrandInterview` node whose JSON body follows `interviewDocument` (the type's
  `jsonSchema`): every answered question in the member's words, with `mentions` that
  reference Wiki nodes (`x-wiki-reference: node`);
- the member's own `Person` (`self`) and each `Person`, `CustomerSegment`, `Problem`,
  `Offering` or `Goal` the answers name, reusing existing records by `existingId`;
- links: `brand_interview_of`, `brand_interview_mentions`, `influenced_by` and
  `serves_audience`.

The app adds its node and edge types to the Wiki add-only on first use, with fixed IDs.
Record IDs are stable per member and key, so saving again proposes only what changed:
an `update` of the interview at its current revision, and records or links the Wiki
does not have yet. A new save is refused while the last batch still awaits review.
`tests/wiki.integration.test.ts` runs this against a real Wiki Worker when
`OUTFITTER_WIKI_PACKAGE` points at a built Wiki operational package.

## Agent

`src/server/agent-route.ts` uses the standard SDK `actionAgent` with the
`AppAgentSidebar` ([app agents](../../../docs/app-agents.md)). Read tools return the
documents; write tools (`creative_team_brand_answer`, `_content_source`,
`_content_profile`, `_map_branch`, `_map_node`, `_draft_save`) prepare private
proposals the member approves. Once sidebars get the platform's MCP tools
(`platformTools`), the agent can also search the member's Wiki and other apps.

## Gaps

- **No social research data.** The source letter relies on a product that scrapes
  posts and shows what performs across platforms. Outfitter has no social
  connectors, so the member pastes their best posts, and the agent records what
  each idea is based on (`research`) and never invents numbers. A future connector
  (X, YouTube, Substack) could fill `sources.examples` automatically.
- **No call transcript intake.** The onboarding call is replaced by the sidebar
  interview; a recorded call could be pasted into answers by hand.
- **No posting or scheduling.** Drafts stop at "ready to post".

## Tests

`npm test --workspace @ai-outfitter/app-creative-team` (unit: domain rules and the
committed schema; integration: the built Worker's GraphQL and page routes).
