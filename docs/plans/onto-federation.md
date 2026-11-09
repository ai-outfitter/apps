# Federated graphs in Onto: Artera, Sunny and Deep Work

Status: findings and a proposal. Nothing here is built.

## The two cases

**Artera and Sunny.** Artera designs the SNSP-1 sensor node and its revisions.
Sunny sells SNY-1, which is SNSP-1 repackaged for consumers and businesses, and
is a customer of Artera. Sunny's graph needs to say "SNY-1 rev A is built from
SNSP-1 rev A" without owning SNSP-1. Artera's graph needs to say "Sunny is a
customer, and this release was delivered for Sunny" without owning Sunny.

**Deep Work, Artera and Sunny.** Deepwork is a product in the public seed,
designed by Outfitter (`seeds/entities-v1.json`). Artera and Sunny would both
use it for their workflows. Each org's graph needs to point at the one Deepwork
product, and neither should have to go through the other to do it.

## What Onto does today

1. **One graph per owner.** Every organization and person has its own Onto
   installation and its own database. Edges have foreign keys to local nodes,
   so an edge can never cross into another org's graph.
2. **Outside records have a key.** A node that stands for something elsewhere
   carries `externalKey` (unique per graph). The forms are Outfitter users,
   Outfitter organizations, GitHub users and another app's record:
   `ai-outfitter.com/apps/<installation>/<type>:<id>`. Only the platform and
   imports set keys, and keys never leave Onto in results
   (`docs/graph-database-plan.md`, `src/server/identity.ts`).
3. **Reads federate as lists, not as one graph.** The platform's MCP fans a
   collection document out over every scope the caller can access and labels
   each record with its organization (webapp
   `docs/graph-collection-federation.md`). Records from Artera and Sunny come
   back side by side. Nothing joins or deduplicates them. Onto publishes only
   `ChangeBatches` as a federated collection; its nodes are read one scope at a
   time.
4. **Cross-deployment references exist in the SDK only.**
   `qualifyGraphReference` adds a deployment id to an entity reference, and
   `docs/graph-providers.md` says it "does not connect to another deployment".
   No Onto code reads through such a reference.
5. **Cross-org writes are not on main.** Draft webapp #771 adds `fromScope`,
   which lets an org call another org's app as role `external`. It is scoped to
   Planning partner requests.
6. **What we have done in practice is copy.** The Nov 4 Sunny batch copied
   segments, the SNSP products and the observability stack into Sunny's Wiki
   with the same IDs as Artera's. The copies match on day one and drift after.
   Nothing says which copy is the source, and an Onto import of both orgs would
   hold two independent "facts" for the same product (the risk
   `docs/wiki-cutover.md` already names for Wiki and Onto copies).

So for both cases, Onto today has no federation: two separate graphs, a key
format that could name a remote record, and a platform that can list records
from both.

## Proposal: reference nodes, owned edges

Keep one graph per owner. When an org needs to talk about a record another org
owns, its graph holds a **reference node**: a node whose `externalKey` names the
origin record. Edges stay local and are owned by whoever wrote them. This is the
pattern `docs/architecture/onto.md` already asks for ("Allow Onto to own
relationships and annotations that refer to source records ... Recheck source
authorization when reading connected records"). It is also how linked-data
systems work: Wikidata items and ActivityPub objects point at an IRI, and
ATProto records point at an `at://` URI with the owner's repo in it.

Artera and Sunny:

```
Sunny's Onto
  PhysicalComponent:snsp-1-rev-a --component_of--> Product:sny-1-rev-a
    (reference: externalKey = Artera's SNSP-1 rev A)
  Organization:artera  (externalKey = ai-outfitter.com/organizations:<artera>)
  Organization:sunny   --customer_of--> Organization:artera

Artera's Onto
  PhysicalComponent:snsp-1-rev-a   (the record itself)
  Organization:sunny   (externalKey = ai-outfitter.com/organizations:<sunny>)
  Release:snsp-1-rev-a --for_customer--> Organization:sunny
```

Deep Work, Artera and Sunny:

```
Outfitter's Onto:  Product:deepwork  (the record itself)
Artera's Onto:     Organization:artera --uses--> Product:deepwork (reference)
Sunny's Onto:      Organization:sunny  --uses--> Product:deepwork (reference)
```

Rules:

- **A reference always names the origin, never another reference.** Sunny's
  Deepwork reference points at Outfitter, not at Artera's reference. Three
  orgs never form a chain, so there is nothing to resolve transitively.
- **One reference per origin record per graph.** The unique `externalKey`
  index already enforces this.
- **A reference stores a slug and title only.** The rest is read from the origin
  at read time, with the caller's own access. A Sunny member who cannot read
  Artera sees the title and "in Artera, not shared with you". Nothing is copied
  that the origin did not publish.
- **Who knows about whom stays private.** Artera's graph does not learn that
  Sunny uses Deepwork. Each org's edges are only in its own graph.
- **Organizations already work this way.** `OutfitterOrganization` keys exist
  for exactly this. The new part is pointing at a node in another org's Onto.

## What it would take

| Piece | Where | Size |
| --- | --- | --- |
| Key form for a node in another owner's Onto | SDK `graph-contracts/external-keys.ts` | small |
| Stage a reference node in a batch (`ref: "artera/PhysicalComponent:snsp-1-rev-a"`), the platform resolves and sets the key | Onto change documents + platform | small |
| Read through a reference with the caller's access, once per request, bounded | Central platform API (not Onto, not an npm package) | medium |
| Show "from Artera" on reference nodes in pages and the explorer | Onto UI | small |
| Replace the copied Sunny records with references during the Onto import | one-off import step | small |

Existing pieces this reuses: `externalKey` and its unique index, batches and
anchors, the platform's scope fan-out and access checks, and
`qualifyGraphReference` for a self-hosted deployment later.

## Not proposed

- A shared joint graph for Artera and Sunny. Communities as their own orgs
  (Oct 28 decision) cover the case where a group really co-owns records.
- Copying records between graphs on a schedule.
- Edges whose ends live in two databases.
- Access derived from the graph. Being a customer grants nothing; platform and
  app access decide what a caller can read.

## Questions

1. Should the key name the org (`ai-outfitter.com/organizations:<uuid>/onto/<node uuid>`)
   or the installation (`ai-outfitter.com/apps/<installation>/<type>:<id>`, today's
   form)? The org form survives a reinstall or the Wiki to Onto move; the
   installation form needs no new code. Recommend the org form.
2. Is "Deep Work" the Deepwork product (designed by Outfitter in the seed), or
   an organization of its own? This doc assumes the product.
3. Should the Onto import for Artera and Sunny turn the copied records into
   references now, or keep the copies until reads through references work?
