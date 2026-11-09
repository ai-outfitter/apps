import { actionAgent } from "@ai-outfitter/app-sdk/action-agent";
import { defineAction, publishActionTools } from "@ai-outfitter/app-sdk/actions";
import type { AgentRoute } from "@ai-outfitter/app-sdk/agent-page";
import {
  agentDatabase,
  installationDatabase,
} from "@ai-outfitter/app-sdk/cloudflare/database";
import { ProposalStore } from "@ai-outfitter/app-sdk/proposal-store";
import {
  requestActor,
  requestIdentity,
  requestOriginActor,
  respond,
} from "@ai-outfitter/app-sdk/server";
import { ontologyContract } from "@ai-outfitter/app-sdk/graph-contracts";
import { typeSegment } from "@ai-outfitter/app-sdk/graph-client";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { z } from "zod";
import { ontologyViolation } from "../lib/ontology-errors";
import { readRelationships, relationshipQuery, relationshipResults } from "../lib/ontology-relationships";
import { auditOntology, auditProposal } from "../lib/ontology-validation";
import { wikiActions } from "../pages/api/internal/actions/v1/[operation]";
import { readGraph } from "./graph";
import { graphChangeInput } from "./graph-changes";
import { documents } from "./documents";
import { assertionInspectInput, assertionInspection, inspectAssertion } from "./ontology-assertions";

// The Wiki assistant's tools: named here and never mounted on the actions route, so they
// are not MCP tools. Agents elsewhere read with graph_query and stage with documents.
const { "graph.apply": apply, ...reads } = publishActionTools("onto", {
  "graph.apply": wikiActions["graph.apply"],
  "batch.inspect": defineAction({
    description: "Inspect a Wiki change batch by its ID using the predefined ChangeBatch query. Returns proposed record attributes, evidence, confidence, policy, deadlines and decisions, including each committed record's address (Person, Organization:sunny or works_on(Person:ada → Project:sunny)) and revision. Read this before discussing or correcting a suggested project. Errors and truncation mean coverage is incomplete; pass refs to read specific proposals without loading the whole batch.",
    access: "read", input: z.strictObject({ id: z.uuid(), refs: z.array(z.string().min(1).max(200)).max(100).optional() }), output: z.json(),
    run: (context, { id, refs }) => wikiActions["graph.graphql"].invoke(context, {
      query: documents.ChangeBatch.document, operationName: "ChangeBatch", variables: { id, ...(refs ? { refs } : {}) }, maxBytes: 65536,
    }),
  }),
  "graph.relationships": defineAction({
    description: "Read direct and derived relationships at business time. Symmetric lookup accepts either participant direction; projections are read-only. Null at returns all intervals. Source records are graph context, not confirmed truth.",
    access: "read", input: relationshipQuery, output: relationshipResults,
    run: async ({ identity }, input) => readRelationships(await readGraph(installationDatabase(), identity), input),
  }),
  "assertion.inspect": defineAction({
    description: "Read a structured assertion and its exact-revision authenticated confirmations. Historical or changed claims do not count as current confirmation.",
    access: "read", input: assertionInspectInput, output: assertionInspection,
    run: ({ identity }, input) => inspectAssertion(installationDatabase(), identity, input),
  }),
  "ontology.audit": defineAction({
    description: "Read-only audit of this Wiki's explicit ontology endpoint constraints, or of one type's proposed contract.",
    access: "read",
    input: z.strictObject({ proposal: z.strictObject({ typeId: z.uuid(), ontology: ontologyContract }).optional() }),
    output: z.array(ontologyViolation),
    run: async ({ identity }, { proposal }) => {
      const graph = await readGraph(installationDatabase(), identity);
      return proposal ? auditProposal(graph, proposal) : auditOntology(graph);
    },
  }),
});

/** Pages the Wiki agent may open; `<type>/<id>` is a node's `path` in the context. */
const routes: AgentRoute[] = [
  { path: "", description: "The Wiki's home entity." },
  { path: "<type>/<id>", description: "An entity's overview." },
  { path: "<type>/<id>/connections", description: "Everything connected to an entity." },
  { path: "<type>/<id>/knowledge-graphs", description: "An entity's knowledge graphs. With `rel` params it draws a draft graph rooted at the entity, which the member can save.",
    params: {
      rel: "Repeat once per relationship type to follow, by its name; append `:incoming` to follow it backwards, and `:<FromType>><ToType>` to follow it only between those record types, either side may be empty (e.g. `part_of:incoming:Project>Organization`).",
      stop: "Repeat once per record type the walk shows but does not expand past (e.g. `Organization`). The starting entity always expands.",
      after: "Repeat once per record type the walk expands one more step from, then stops (e.g. `Organization` to show a competitor's other offerings without their competitors).",
      graph: "The saved knowledge graph being adjusted, so the member can update it. Start from a saved graph's `selectedGraph.query`, which already includes it.",
      depth: "Steps from the root, 1 to 10 (default 2).",
      max: "Most records drawn, 1 to 200 (default 100).",
    } },
  { path: "<type>/<id>/knowledge-graphs/<graphId>", description: "One saved knowledge graph drawn from the entity." },
  { path: "<type>/<id>/org-chart", description: "An organization's org chart." },
  { path: "contexts", description: "Every knowledge graph definition." },
  { path: "graph", description: "The graph explorer." },
  { path: "types", description: "Entity and relationship types." },
  { path: "changes", description: "Proposed and recent Wiki change batches." },
  { path: "changes/<batchId>", description: "Inspect one batch, its proposed records, evidence and decisions." },
];
export function agentRoute(
  request: Request,
  operation: string,
  locals: unknown,
  internal = false,
) {
  return respond(async () => {
    if (import.meta.env.OUTFITTER_APP_MODE !== "operational")
      throw new Response("Read-only demo", { status: 403 });
    const identity = requestIdentity(request);
    const context = () => ({
      identity,
      actor: requestActor(request, identity),
      originActor: requestOriginActor(request, identity),
      db: () => installationDatabase(),
    });
    const agent = actionAgent({
      store: new ProposalStore(agentDatabase(), identity, {
        table: "wiki_map_proposals",
        guard: "wiki_map_agent_guard",
      }),
      host: workflowHost<"interactive">(locals as never),
      type: "onto.conversation",
      contextType: "onto.page",
      focusId: "e9500000-0000-4000-8000-000000000002",
      label: "Onto",
      context,
      instructions:
        "You are Onto, the agent managing this owner’s ontological knowledge graph. Explain stored entities, ontology constraints and evidence. Prepare exact graph changes for review. Do not manufacture assertion confirmation or infer authority from relationships. To build or reshape a knowledge graph, open the entity's knowledge-graphs page with `rel`, `stop`, `after`, `depth` and `max` params; to change a saved graph, start from its `selectedGraph.query` and change only what the member asked; `currentPage.state.relationshipsHere` lists relationship types touching the entity. Read relationships with your tools before choosing params. On a Changes page, inspect its batch with batch.inspect (the predefined ChangeBatch query); pending suggestions are not saved entities. Use operation attributes and evidence to explain the project, and record/recordRevision for a committed record correction. Never guess missing records or revisions. Submitted batches are frozen: explain that pending incorrect suggestions must be rejected by the member and replaced; do not apply them as saved records.",
      reads,
      actions: {
        "graph.apply": {
          retry: "same-request",
          action: apply,
          prepare: (input, requestId) =>
            graphChangeInput.parse({
              ...z.record(z.string(), z.unknown()).parse(input),
              requestKey: requestId,
            }),
        },
      },
      routes,
      page: async (view) => {
        const batchId = /^changes\/([0-9a-f-]{36})$/i.exec(view?.location.split(/[?#]/, 1)[0] ?? "")?.[1];
        if (batchId && z.uuid().safeParse(batchId).success) {
          const batch = await reads["batch.inspect"].invoke(context(), { id: batchId }, true);
          return { batch };
        }
        const graph = await readGraph(installationDatabase(), identity);
        const segment = new Map(graph.types.map((type) => [type.id, typeSegment(type.name)]));
        // The entity the member is looking at comes first, so it is never cut off.
        const current = (view?.state?.entity as { id?: unknown } | undefined)?.id;
        const nodes = [...graph.nodes].sort((a, b) => Number(b.id === current) - Number(a.id === current));
        return {
          types: graph.types.slice(0, 100),
          nodes: nodes.slice(0, 25).map((node) => ({
            id: node.id,
            path: `${segment.get(node.typeId) ?? "entities"}/${node.id}`,
            revision: node.revision,
            typeId: node.typeId,
            title: node.title,
            body: node.body.slice(0, 1500),
            bodyTruncated: node.body.length > 1500,
          })),
          limited: graph.types.length > 100 || graph.nodes.length > 25,
        };
      },
    });
    return internal
      ? agent.provider(request, operation)
      : agent.browser(request, operation);
  });
}
