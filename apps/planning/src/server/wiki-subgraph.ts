/**
 * The part of the owner's Wiki that Planning's project rules read, fetched with the
 * Wiki's bounded `graph.query` instead of the whole graph: each project's anchor page
 * (by canonical `source`), the use cases and stories that name the installation in
 * their properties, and what Planning's selection reaches from them; optionally the
 * offerings, revisions and demonstrations of the products reached. The records come
 * back in the same shape `readWikiGraph` gives, so `project-readiness.ts` runs on them
 * unchanged, and a superset is harmless: its rules select from whatever is loaded.
 */
import type { GraphQueryInput, GraphQueryResult } from "@ai-outfitter/app-sdk/graph-query";
import { queryWikiGraph, wikiGraphRecords } from "@ai-outfitter/app-sdk/graph-client";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";

type Host = WorkflowHost<"interactive">;
type Query = GraphQueryInput["queries"][number];
type Row = GraphQueryResult["nodes"][number];
const productTypes = ["Product", "SoftwareProduct"];

/** The same selection as `projectContext` in project-readiness.ts, as graph.query's inline selection. */
export const projectContextSelection = {
  rootTypes: ["Project", "UseCase", "UserStory"],
  relationships: [
    "has_use_case", "has_story", "has_requirement", "has_acceptance_criterion", "addresses", "pursues", "experiences", "produces", "measured_by",
    // A direct association may describe work on an existing product; organizational part_of links are not followed.
    ...productTypes.map((product) => ({ type: "part_of", direction: "outgoing" as const, from_type: "Project", to_type: product })),
    // The customer segments that experience a selected problem.
    { type: "experiences", direction: "incoming" as const, from_type: "CustomerSegment", to_type: "Problem" },
  ],
  nodeTypes: ["Problem", "Goal", "MetricDefinition", "CustomerSegment", "UserStory", "UseCase", "Requirement", "AcceptanceCriterion", ...productTypes],
  // Shared context is terminal: never borrow another project's scope.
  terminalTypes: [...productTypes, "Goal", "MetricDefinition", "CustomerSegment"],
  // A selected problem shows the customer segments that experience it and nothing beyond them.
  stopAfterTypes: ["Problem"],
  maxDepth: 6,
  maxNodes: 500,
};

/** What readiness reads around a product: its offerings, revisions and their demonstrations. */
export const productContextSelection = {
  rootTypes: productTypes,
  relationships: [
    { type: "packages_product", direction: "incoming" as const, from_type: "Offering" },
    { type: "revision_of", direction: "incoming" as const, from_type: "ProductRevision" },
    { type: "demonstrates", direction: "incoming" as const, from_type: "Demonstration", to_type: "ProductRevision" },
  ],
  nodeTypes: ["Offering", "ProductRevision", "Demonstration"],
  terminalTypes: ["Offering", "Demonstration"],
  maxDepth: 2,
  maxNodes: 500,
};

const MAX_PAGES = 20;
const bounded = () => new Response("Project context exceeds the Wiki query's bounds", { status: 413 });

/** Every page of each query, merged: a query continues on its cursor with every other field unchanged. */
async function queryAll(host: Host, queries: Query[]) {
  const rows = { types: new Map<string, GraphQueryResult["types"][number]>(), nodes: new Map<string, GraphQueryResult["nodes"][number]>(), edges: new Map<string, GraphQueryResult["edges"][number]>() };
  let wiki: Awaited<ReturnType<typeof queryWikiGraph>>["wiki"] | undefined;
  let pending = queries;
  for (let page = 0; page < MAX_PAGES && pending.length; page++) {
    const result = await queryWikiGraph(host, { maxBytes: 256 * 1024, queries: pending });
    wiki ??= result.wiki;
    for (const kind of ["types", "nodes", "edges"] as const) for (const row of result[kind]) rows[kind].set(String(row.id), row as never);
    // A root whose expansion did not fit would hide records the in-memory rules expect.
    if (Object.values(result.queries).some((answer) => answer.omitted.length > 0)) throw bounded();
    pending = pending.flatMap((query) => {
      const cursor = result.queries[query.name]?.cursor;
      return cursor ? [{ ...query, cursor }] : [];
    });
  }
  if (pending.length || !wiki) throw bounded();
  return { wiki, types: [...rows.types.values()], nodes: [...rows.nodes.values()], edges: [...rows.edges.values()] };
}

/** The offerings, revisions and demonstrations around these products; none in a Wiki without those types. */
async function productContext(host: Host, productIds: string[]) {
  try {
    return await queryAll(host, [{ name: "products", entity: "node", ids: productIds.slice(0, 200), expand: productContextSelection, fields: "full", limit: 200 }]);
  } catch (error) {
    // The selection names no type this Wiki has: there is no product context to read.
    if (error instanceof Response && error.status === 400) return { types: [], nodes: [], edges: [] };
    throw error;
  }
}

type Rows = Awaited<ReturnType<typeof queryAll>>;
const asRecords = ({ wiki, types, nodes, edges }: Rows) =>
  ({ wiki, ...wikiGraphRecords({ installationId: wiki.installationId, types: types as never, nodes: nodes as never, edges: edges as never }, true) });

/** Where a project's work is read: its anchor page, what its planning edges reach, and the artifact definitions attached to it. */
export const workContextSelection = {
  rootTypes: ["Project"],
  relationships: [
    ...["has_requirement", "has_acceptance_criterion", "has_use_case", "has_story", "has_issue", "addresses", "pursues", "experiences"],
    { type: "artifact_for", direction: "incoming" as const, from_type: "ArtifactDefinition", to_type: "Project" },
  ],
  // Another project's scope is never borrowed; definitions are read, not walked from.
  stopAtTypes: ["Project"],
  terminalTypes: ["ArtifactDefinition"],
  maxDepth: 6,
  maxNodes: 500,
};

/** The product revisions a project produces and the products they revise. */
export const projectProductsSelection = {
  rootTypes: ["Project"],
  relationships: [
    { type: "produces", direction: "outgoing" as const, from_type: "Project", to_type: "ProductRevision" },
    { type: "revision_of", direction: "outgoing" as const, from_type: "ProductRevision" },
  ],
  nodeTypes: ["ProductRevision", ...productTypes],
  terminalTypes: productTypes,
  maxDepth: 2,
  maxNodes: 200,
};

/** The repositories a project's code lives in. */
export const projectRepositoriesSelection = {
  rootTypes: ["Project"],
  relationships: [{ type: "source_in", direction: "outgoing" as const, from_type: "Project", to_type: "Repository" }],
  nodeTypes: ["Repository"],
  terminalTypes: ["Repository"],
  maxDepth: 1,
  maxNodes: 100,
};

/** What a project page shows from the Wiki: the goals it pursues, its use cases and stories, its releases and their evidence. */
export const projectBodySelection = {
  rootTypes: ["Project"],
  relationships: [
    { type: "pursues", direction: "outgoing" as const, from_type: "Project", to_type: "Goal" },
    { type: "has_use_case", direction: "outgoing" as const, from_type: "Project", to_type: "UseCase" },
    { type: "has_story", direction: "outgoing" as const, to_type: "UserStory" },
    { type: "part_of", direction: "incoming" as const, from_type: "Release", to_type: "Project" },
    { type: "documents", direction: "incoming" as const, from_type: "Document" },
    { type: "includes_record", direction: "outgoing" as const, from_type: "Document", to_type: "Demonstration" },
  ],
  nodeTypes: ["Goal", "UseCase", "UserStory", "Release", "Document", "Demonstration"],
  terminalTypes: ["Goal", "UserStory", "Demonstration"],
  maxDepth: 3,
  maxNodes: 300,
};

/** One project's subgraph under a selection, in `readWikiGraph`'s shape: a superset the in-memory rules select from. */
export async function readProjectSelection(host: Host, installationId: string, projectId: string, expand: Query["expand"]) {
  const rows = await queryAll(host, [{ name: "project", entity: "node", sources: [{ installationId, type: "project", id: projectId }], expand, fields: "full", limit: 10 }]);
  // The walk returns the edges it followed; callers also read the other edges between selected pages.
  const nodeIds = rows.nodes.map((node) => String(node.id));
  if (nodeIds.length) {
    const chunks = Array.from({ length: Math.ceil(nodeIds.length / 200) }, (_, i) => nodeIds.slice(i * 200, i * 200 + 200));
    const around = await queryAll(host, chunks.map((ids, i) => ({ name: `edges${i}`, entity: "edge" as const, touching: { nodeIds: ids, direction: "outgoing" as const }, fields: "full" as const, limit: 500 })));
    rows.edges = [...new Map([...rows.edges, ...around.edges].map((row) => [String(row.id), row])).values()];
  }
  // Expansion carries compact type rows; callers render type definitions, so read the ones in use in full.
  const typeIds = [...new Set([...rows.nodes, ...rows.edges].map((row) => String(row.typeId)))];
  if (!typeIds.length) return asRecords(rows);
  const full = await queryAll(host, [{ name: "types", entity: "type", ids: typeIds.slice(0, 200), fields: "full", limit: 200 }]);
  return asRecords({ ...rows, types: full.types });
}

/**
 * The Wiki records Planning's project rules read for these projects, as entity records
 * (`readWikiGraph`'s shape). With `products`, the offerings, revisions and demonstrations
 * of every product reached are included, which readiness reports on.
 */
export async function readProjectSubgraph(host: Host, installationId: string, projectIds: string[], { products = false } = {}) {
  const sources = projectIds.slice(0, 100).map((id) => ({ installationId, type: "project", id }));
  const first = await queryAll(host, [
    { name: "anchors", entity: "node", sources, expand: projectContextSelection, fields: "full", limit: 100 },
    { name: "explicit", entity: "node", types: ["UseCase", "UserStory"], properties: { planning_installation_id: installationId }, expand: projectContextSelection, fields: "full", limit: 500 },
  ]);
  let { types, nodes, edges } = first;
  if (products) {
    const typeName = new Map(types.map((type) => [String(type.id), String(type.name ?? "")]));
    const productIds = nodes.filter((node) => productTypes.includes(typeName.get(String(node.typeId)) ?? "")).map((node) => String(node.id));
    if (productIds.length) {
      const around = await productContext(host, productIds);
      const merge = (a: Row[], b: Row[]) => [...new Map([...a, ...b].map((row) => [String(row.id), row])).values()];
      types = merge(types, around.types);
      nodes = merge(nodes, around.nodes);
      edges = merge(edges, around.edges);
    }
  }
  return asRecords({ wiki: first.wiki, types, nodes, edges });
}
