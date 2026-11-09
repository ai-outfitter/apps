import type { ActionContext } from "@ai-outfitter/app-sdk/actions";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import type { PullRequestHost } from "@ai-outfitter/app-sdk/github-pulls";
import { enableAuditSchedule } from "../../../../../server/ontology-audit";
import { graphProviderDescriptor } from "@ai-outfitter/app-sdk/graph-provider";
import { describeOntoGraph } from "../../../../../server/graph-provider";
import type { APIRoute } from "astro";
import { knowledgeGraphRenderInput, knowledgeGraphRenderResult } from "@ai-outfitter/app-sdk/graph-templates";
import { renderKnowledgeGraphRecords } from "../../../../../server/knowledge-graph-select";
import { z } from "zod";
import type { AppActor, AppIdentity } from "@ai-outfitter/app-sdk/server";
import { wikiGraphReadInput, wikiGraphReadResult } from "@ai-outfitter/app-sdk/graph-contracts";
import { readGraphSnapshot } from "../../../../../server/graph-read";
import { graphQueryInput, graphQueryResult } from "@ai-outfitter/app-sdk/graph-query";
import { queryGraphRecords } from "../../../../../server/graph-query";
import { graphGraphqlInput, graphGraphqlResult } from "@ai-outfitter/app-sdk/graph-graphql";
import { graphqlGraphRecords } from "../../../../../server/graph-graphql";
import { actionAPI, defineAction } from "@ai-outfitter/app-sdk/actions";
import { mutateAction } from "@ai-outfitter/app-sdk/app-graphql";
import { agentDatabase, installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { reviewInBackground } from "../../../../../server/batch-review";
import { applyGraphChanges, graphChangeInput, graphChangeReceipt } from "../../../../../server/graph-changes";
import { graphqlSchema } from "../../../../../server/graphql";
import { artifactActions } from "../../../../../server/artifact-preview";
import {
  addToBatch, batchAddInput, batchIdInput, batchOpenInput, batchSubmitInput, getBatch, openBatch, sealDueBatches, submitBatch,
} from "../../../../../server/graph-batches";

// What other apps and the platform call over actions.call; none is an MCP tool. Agents
// stage Wiki changes with the mutation documents graph.mutate runs (server/documents.ts)
// and read with graph_query and graph_search. Forerunner opens its policy batches
// with batch.open and stages with the same documents; a member commits batches on the
// Changes page.
const writer = ({ identity }: { identity: { canEdit: boolean; entityWriter?: string } }) => identity.canEdit || !!identity.entityWriter;
const batchResult = z.record(z.string(), z.json());
export const wikiActions = {
  "graph.cutover-status": defineAction({
    description: "List trusted legacy Wiki migrations into this installation; portable imports cannot create these receipts.",
    access: "read", input: z.strictObject({}), output: z.object({ sourceInstallationIds: z.array(z.string()) }),
    run: async ({ identity }) => ({ sourceInstallationIds: (await agentDatabase().query({sql: "SELECT DISTINCT sourceInstallationId FROM onto_wiki_migrations WHERE destinationInstallationId=?",params:[identity.installationId]})).map(row => String(row.sourceInstallationId)) }),
  }),
  ...artifactActions,
  "graph.describe": defineAction({
    description: "Describe Onto graph contracts, supported types and capabilities. Discovery grants no record access.",
    access: "read", input: z.strictObject({}), output: graphProviderDescriptor,
    run: () => describeOntoGraph(installationDatabase()),
  }),
  "batch.open": defineAction({
    description: "Open a Wiki change batch: a staged set of graph.apply operations that stays invisible to every read until it commits. Policy member (default) waits for a member; confidence commits operations at or above threshold (at least 0.9) on submit and, with reviewWindow ({until:\"end-of-day\",timezone} or {hours}), commits what is still waiting when the window ends unless a member rejects it; first-run commits everything on submit, once per Wiki, for a discovery-run source. Example: {\"title\":\"Daily discovery\",\"source\":{\"kind\":\"discovery-run\",\"ref\":\"<run id>\"},\"policy\":{\"kind\":\"confidence\",\"threshold\":0.95,\"version\":\"discovery-2026-11\",\"reviewWindow\":{\"until\":\"end-of-day\",\"timezone\":\"America/Chicago\"}}}.",
    access: "write", canInvoke: writer, input: batchOpenInput, output: batchResult,
    run: ({ identity, actor }, input) => openBatch(installationDatabase(), identity, actor, input),
  }),
  "batch.add": defineAction({
    description: "Add up to 100 proposals to an open batch. Each proposal is one graph.apply operation (create or update of graph-node, graph-edge or graph-type, with $ref temporary references that persist across calls) plus evidence citations (@ai-outfitter/app-sdk/evidence: provider, recordId, version, uri, quote, observedAt, contentHash; at most 32), the producing agent's confidence (0-1) and a short reason. Re-adding an identical proposal is a no-op. Nothing becomes visible.",
    access: "write", canInvoke: writer, input: batchAddInput, output: batchResult,
    run: ({ identity, actor }, input) => addToBatch(installationDatabase(), identity, actor, input),
  }),
  "batch.submit": defineAction({
    description: "Freeze an open batch and apply its policy: confidence or first-run commits what it may now; the rest waits for review. Refused while validation fails. Optional summary text for the person reviewing. The ontology steward then reviews it in the background and attaches advisory findings (batch.review, null until it finishes); they change no decision.",
    access: "write", canInvoke: writer, input: batchSubmitInput, output: batchResult,
    run: async ({ identity, actor, afterSubmit }: { identity: AppIdentity; actor: AppActor; afterSubmit?: (batchId: string) => void }, input) => {
      const result = await submitBatch(installationDatabase(), identity, actor, input);
      afterSubmit?.(input.batchId);
      return result;
    },
  }),
  "batch.get": defineAction({
    description: "Read one batch: its state, policy, summary, review deadline, the ontology steward's latest advisory review (findings by operation ref and its batch-review run) and every operation with evidence, confidence, reason, decision and committed record.",
    access: "read", input: batchIdInput, output: batchResult,
    run: ({ identity }, input) => getBatch(installationDatabase(), identity, input),
  }),
  "batch.seal-due": defineAction({
    description: "Commit, by policy, the waiting operations of batches whose review window has ended, and discard expired open batches.",
    access: "write", canInvoke: writer, input: z.strictObject({}), output: batchResult,
    run: ({ identity }) => sealDueBatches(installationDatabase(), identity),
  }),
  "knowledge-graph.render": defineAction({
    description: "Flatten a bounded graph into Markdown: select it (a saved KnowledgeGraph definitionId, an inline definition or a query, with rootIds and maxNodes), then render it through the caller's graph templates. Example: {\"definitionId\":\"<KnowledgeGraph id>\",\"rootIds\":[\"<root id>\"],\"templates\":[{\"version\":1,\"order\":0,\"name\":\"Overview\",\"bindings\":{\"root\":{\"op\":\"ref\",\"id\":\"$params.rootId\"}},\"sections\":[{\"heading\":\"$root.title\",\"level\":1,\"fields\":[]}]}]}. Templates read only the selected records. Response: {document: {markdown, sources, complete, omitted, unresolved, ...}, selection} where selection is the selected graph, including the query, hash and variables it read with.",
    access: "read", input: knowledgeGraphRenderInput, output: knowledgeGraphRenderResult,
    run: ({ identity }, input) => renderKnowledgeGraphRecords(installationDatabase(), identity, input),
  }),
  "graph.query": defineAction({
    description: "Bulk read in one request: up to 12 named queries matching nodes, edges or types by type name or ID, exact IDs, (nodes) exact slugs, text, archived state and (edges) touching node IDs. Example: {\"queries\":[{\"name\":\"roles\",\"types\":[\"Role\"],\"expand\":{\"edgeTypes\":[\"holds\"]}},{\"name\":\"inventory\",\"entity\":\"all\",\"aggregate\":\"type\"}]}. Node queries can expand along named edge types (depth 1-3) with the knowledge-graph traversal; matched edges bring their endpoint nodes. Compact fields by default; fields:\"full\" for stored records. aggregate:\"type\" (with entity \"all\" or one kind) returns counts by type instead of records. Records and compact type signatures (ontology, properties, contractHash, bodySchemaHash, docHash) are deduplicated. maxBytes bounds the response; MCP graph_search runs the same queries across every accessible Wiki; up to 100 matched nodes expand per request. Every query reports total, complete and a cursor; continue a cursor on its own Wiki only. Read only.",
    access: "read", input: graphQueryInput, output: graphQueryResult,
    run: ({ identity }, input) => queryGraphRecords(installationDatabase(), identity, input),
  }),
  "graph.graphql": defineAction({
    description: "GraphQL read over this Wiki. Example: {\"query\":\"{ persons(first: 20) { nodes { slug title edges(direction: OUTGOING) { __typename to { slug title } } } aggregate { count } } }\"}. Example: {\"query\":\"{ search(text: \\\"a\\\", first: 10) { __typename slug title } }\"}. The schema is generated from this Wiki's types on every call (read it with { sdl } or __schema/__type): each node type becomes a PascalCase object type with a singular root field (camelCase; slug or id, archived: a slug is the node's address, unique in this Wiki, so node(slug:) finds any type) and a plural connection (first, after, archived, ids, slugs, text) returning nodes, pageInfo and aggregate { count }; stored properties are typed fields. Edge types with ontology endpoints add `<edge>` and `<edge>Edges` fields on source types and `<edge>Incoming`/`<edge>IncomingEdges` on target types (at, archived); every node has edges(types, direction), returning edge objects with from and to. Relator slots are fields named after the slot, and participant types get the relator connection with as: \"<slot>\". Archived records are excluded by default; relationships also hide retired ones. Depth 8 and 2000 fields at most; the whole response stays within maxBytes: lists are cut (extensions.truncated, truncatedPaths), never records, and a response that cannot fit returns RESPONSE_TOO_LARGE. Read only.",
    access: "read", input: graphGraphqlInput, output: graphGraphqlResult,
    run: (context: ActionContext & { host?: () => PullRequestHost }, input) => graphqlGraphRecords(installationDatabase(), context.identity, input, context),
  }),
  "graph.read": defineAction({
    description: "Read the complete active Wiki snapshot. Returns stored types, nodes, relationships and revisions; no Markdown or prompt generation. Real Wikis exceed the MCP response limit: use graph_search (graph.query) or graph_query for bulk reads.",
    access: "read", input: wikiGraphReadInput, output: wikiGraphReadResult,
    run: ({ identity }, input) => readGraphSnapshot(installationDatabase(), identity, input),
  }),
  "graph.apply": defineAction({
    description: "Atomically create or update up to 100 Wiki types, nodes and edges. Temporary refs resolve within this installation. Retry identical changes with the same requestKey for the original ID/revision receipt. Canonical app records use the entity API.",
    access: "write", canInvoke: writer, input: graphChangeInput, output: graphChangeReceipt,
    run: ({ identity }, input) => applyGraphChanges(installationDatabase(), identity, input),
  }),
  // Agents' change batches (server/graphql.ts); editors and app writers, as batch.* allow.
  "graph.mutate": mutateAction(graphqlSchema, { canInvoke: writer }),
};
export const ALL: APIRoute = ({ request, params, locals }) => {
  if (import.meta.env.OUTFITTER_APP_MODE !== "operational")
    return new Response("Read-only demo", { status: 403 });
  return actionAPI(request, params.operation ?? "", {
    ...wikiActions,
    "onto.schedule": defineAction({
      description: "Enable Onto’s daily graph audit and durable review processing as the acting editor. The platform checks schedule authority.",
      access: "write", input: z.strictObject({}), output: z.json(),
      run: () => enableAuditSchedule(workflowHost<"interactive">(locals)),
    }),
  }, (identity) => ({
    db: () => installationDatabase(),
    host: () => workflowHost<"interactive">(locals),
    afterSubmit: (batchId: string) => reviewInBackground(locals, installationDatabase(), identity, batchId),
  }));
};
