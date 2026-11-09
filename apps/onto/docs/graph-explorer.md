# Graph explorations

An **exploration** is a saved view of the graph that a member and the sidebar
agent (Ask Onto) change together: where it starts, which relationships were
opened from which nodes, and which nodes are hidden. It holds no facts, so every
read rebuilds its picture from current records.

> Start from my org and view all my product offerings, their projects and then
> their active issues/PRs or competitors. (Nicholas, 2026-11-08)

Nicholas's choices: view changes apply at once; new records stay staged change
batches, drawn dashed until a member commits them; the page reads the
exploration again after each finished Ask Onto reply instead of polling.

| Agent says | What happens |
| --- | --- |
| "Show Sunny's offerings" | A step is added to the exploration |
| "Hide the archived projects" | Nodes are added to `hidden` |
| "Add Ecowitt as a competitor" | A change batch is staged; the picture shows it dashed |

## State

`{ title, start: { type, slug }, steps, hidden, focus?, direction? }`, stored in
`graph_explorations` with `revision` and `lastChange { by, via, summary, nodes }`.
The page outlines `lastChange.nodes`.

A step is `{ from, path, direction?, limit?, type?, state? }`. `from` is a node
key, or `*<step>` for every node that step reached. `limit` defaults to 25.

Node keys are Onto node addresses, `<Type>:<slug>`. Pull requests are
`github:<owner>/<repo>#<number>`, and staged records are
`proposed:<batch id>/<ref>`.

## Paths

| Path | From | Through |
| --- | --- | --- |
| `offerings` | Organization | Offering `offered_by` |
| `products` | Offering | `packages_product` |
| `projects` | Organization, Offering, Product | `part_of`, or the products' `produces` |
| `competitors` | Organization, Offering, Product | `alternative_for`, plus the competitor's company |
| `issues` | any | `Issue` nodes linked by any edge |
| `repositories` | Project | `source_in` |
| `pullRequests` | Project, Repository | Live from the member's GitHub connection (`state` open by default); never stored |

Any edge type name works as a path too. A path that fails reports its error on
its step; the rest of the picture still loads.

## Documents

`Explorations`, `Exploration(slug)` and `MutateExploration { slug,
expectedRevision, patch, summary?, dryRun }`. The patch is an RFC 7386 merge
patch. `expectedRevision: 0` creates, `steps: { key: null }` removes a step, and
a stale revision is a 409. The answer is the new picture.

## Code

- `src/lib/exploration-picture.ts`: the resolver and the patch step. They run
  on the server and, in the read-only demo, in the browser over
  `fixtures/exploration.ts`.
- `src/server/explorations.ts`: storage, staged proposals, live pull requests.
- `src/pages/explore/[slug].astro`, `src/scripts/exploration.ts`: the page.
  It describes itself with `agentPage("onto").describe` and re-reads on
  `onReplied`.

Not built: GitHub issues, and an eval of the ask through the MCP.
