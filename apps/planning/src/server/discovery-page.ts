import { graphDatabase, type GraphDatabase } from "./graph-database";
import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";
import {
  workflowHost,
  type WorkflowHost,
} from "@ai-outfitter/app-sdk/workflow-host";
import { requestIdentity, requestPageURL } from "@ai-outfitter/app-sdk/server";
import { typeSegment } from "@ai-outfitter/app-sdk/graph-client";
import type { listDiscovery } from "./discovery";
import { wikiPageHref } from "./wiki-links";

type DiscoveryKind = "opportunities" | "customer-segments";
type DiscoveryData = Awaited<ReturnType<typeof listDiscovery>>;

function relatedDiscoveryRecord(
  edge: EntityRecord,
  record: EntityRecord,
  nodes: Map<string, EntityRecord>,
  types: Map<string, EntityRecord>,
  data: DiscoveryData,
  url: URL,
) {
  const id =
    edge.attributes.fromId === record.ref.id
      ? edge.attributes.toId
      : edge.attributes.toId === record.ref.id
        ? edge.attributes.fromId
        : null;
  const node = nodes.get(String(id));
  if (!node) return [];
  const type = types.get(String(node.attributes.typeId));
  const name = String(type?.attributes.name ?? "");
  const route =
    name === "Problem"
      ? "opportunities"
      : name === "CustomerSegment"
        ? "customer-segments"
        : undefined;
  return [
    {
      id: node.ref.id,
      title: node.title,
      kind: String(type?.title || name || "Related record"),
      href: route
        ? `/${route}/${encodeURIComponent(node.ref.id)}`
        : wikiPageHref(
            data.wiki,
            url,
            `${type ? typeSegment(name) : "entities"}/${encodeURIComponent(node.ref.id)}`,
          ),
    },
  ];
}

/** Resolve card summaries and related navigation once, before rendering HTML. */
export function discoveryView(
  data: DiscoveryData,
  kind: DiscoveryKind,
  url: URL,
  recordId = "",
) {
  const nodes = new Map(data.graph.nodes.map((node) => [node.ref.id, node]));
  const types = new Map(data.graph.types.map((type) => [type.ref.id, type]));
  const priority = (name: string) =>
    /customer.?segment/i.test(name)
      ? 0
      : /use.?case/i.test(name)
        ? 1
        : /project/i.test(name)
          ? 2
          : 3;
  const records = data.records
    .filter((record) => !recordId || record.ref.id === recordId)
    .map((record) => {
      const related = data.graph.edges
        .flatMap((edge) => {
          return relatedDiscoveryRecord(edge, record, nodes, types, data, url);
        })
        .sort(
          (a, b) =>
            priority(a.kind) - priority(b.kind) ||
            a.title.localeCompare(b.title),
        );
      return {
        id: record.ref.id,
        title: record.title,
        summary: String(record.attributes.summary ?? ""),
        href: `/${kind}/${encodeURIComponent(record.ref.id)}`,
        related,
      };
    });
  const record = recordId
    ? data.records.find((row) => row.ref.id === recordId)
    : undefined;
  // Only the selected detail's neighborhood is sent for interactive graph controls.
  const edges = record
    ? data.graph.edges.filter(
        (edge) =>
          edge.attributes.fromId === recordId ||
          edge.attributes.toId === recordId,
      )
    : [];
  const ids = new Set([
    recordId,
    ...edges.flatMap((edge) => [
      String(edge.attributes.fromId),
      String(edge.attributes.toId),
    ]),
  ]);
  return {
    wiki: data.wiki,
    records,
    graph: record
      ? {
          record,
          wiki: data.wiki,
          graph: {
            types: data.graph.types,
            edges,
            nodes: data.graph.nodes.filter((node) => ids.has(node.ref.id)),
          },
        }
      : null,
  };
}

type WikiCollection =
  GraphDatabase extends { collection(name: string): infer C }
    ? C
    : never;
async function listAll(
  collection: WikiCollection,
  where: Record<string, unknown>,
  select: string[],
  order?: { field: string; direction: "asc" | "desc" },
) {
  const result: EntityRecord[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await collection.list({
      where,
      select,
      order,
      offset,
      limit: 100,
    });
    result.push(...page);
    if (page.length < 100) return result;
  }
}
async function optionalGet(collection: WikiCollection, id: string) {
  try {
    return await collection.get(id);
  } catch (error) {
    if (error instanceof Response && error.status === 404) return undefined;
    throw error;
  }
}

async function discoveryNeighborhood(
  records: EntityRecord[],
  type: EntityRecord,
  nodes: WikiCollection,
  edges: WikiCollection,
  types: WikiCollection,
) {
  const relatedEdges: EntityRecord[] = [];
  // The SDK currently supports one incident node per edge query. Bound parallel
  // reads while retaining every matching record; never download the whole Wiki.
  for (let offset = 0; offset < records.length; offset += 8) {
    const pages = await Promise.all(
      records
        .slice(offset, offset + 8)
        .map((record) =>
          listAll(edges, { nodeId: record.ref.id, archived: false }, [
            "typeId",
            "fromId",
            "toId",
          ]),
        ),
    );
    relatedEdges.push(...pages.flat());
  }
  const uniqueEdges = [
    ...new Map(relatedEdges.map((edge) => [edge.ref.id, edge])).values(),
  ];
  const relatedNodes = new Map(
    records.map((record) => [record.ref.id, record]),
  );
  const missingIds = [
    ...new Set(
      uniqueEdges.flatMap((edge) => [
        String(edge.attributes.fromId),
        String(edge.attributes.toId),
      ]),
    ),
  ].filter((id) => !relatedNodes.has(id));
  for (let offset = 0; offset < missingIds.length; offset += 8) {
    const found = await Promise.all(
      missingIds.slice(offset, offset + 8).map((id) => optionalGet(nodes, id)),
    );
    for (const node of found)
      if (node && !node.attributes.archived)
        relatedNodes.set(node.ref.id, node);
  }
  const relatedTypes = new Map<string, EntityRecord>([[type.ref.id, type]]);
  const typeIds = [
    ...new Set(
      [...relatedNodes.values()].map((node) => String(node.attributes.typeId)),
    ),
  ].filter((id) => !relatedTypes.has(id));
  for (let offset = 0; offset < typeIds.length; offset += 8) {
    const found = await Promise.all(
      typeIds.slice(offset, offset + 8).map((id) => optionalGet(types, id)),
    );
    for (const definition of found)
      if (definition && !definition.attributes.archived)
        relatedTypes.set(definition.ref.id, definition);
  }
  return {
    nodes: [...relatedNodes.values()],
    types: [...relatedTypes.values()],
    edges: uniqueEdges.filter(
      (edge) =>
        relatedNodes.has(String(edge.attributes.fromId)) &&
        relatedNodes.has(String(edge.attributes.toId)),
    ),
  };
}

export async function readDiscoveryPage(
  host: WorkflowHost<"interactive">,
  kind: DiscoveryKind,
  url: URL,
  recordId = "",
) {
  const database = await graphDatabase(host);
  const types = database.collection("types");
  const nodes = database.collection("nodes");
  const edges = database.collection("edges");
  const candidates = await types.list({
    where: {
      name: kind === "opportunities" ? "Problem" : "CustomerSegment",
      category: "node",
      archived: false,
    },
    select: ["name", "category", "archived"],
    limit: 2,
  });
  if (candidates.length !== 1)
    throw new Response("Wiki context type is unavailable or ambiguous", {
      status: 409,
    });
  const type = candidates[0];
  const selected = recordId ? await optionalGet(nodes, recordId) : undefined;
  const records = recordId
    ? selected &&
      selected.attributes.typeId === type.ref.id &&
      !selected.attributes.archived
      ? [selected]
      : []
    : await listAll(
        nodes,
        { typeId: type.ref.id, archived: false },
        ["typeId", "summary", "archived"],
        { field: "title", direction: "asc" },
      );
  const graph = await discoveryNeighborhood(records, type, nodes, edges, types);
  return discoveryView(
    {
      wiki: {
        installationId: database.installationId,
        hostname: database.hostname,
        slug: database.slug,
        writable: false,
      },
      records,
      graph,
    },
    kind,
    url,
    recordId,
  );
}

export function demoDiscoveryPage(
  kind: DiscoveryKind,
  url: URL,
  recordId = "",
) {
  const problem = kind === "opportunities";
  const record: EntityRecord = {
    ref: { installationId: "demo", type: "graph-node", id: "example" },
    revision: 1,
    references: [],
    title: problem
      ? "Teams struggle to choose useful work"
      : "Small project teams",
    attributes: {
      summary: problem
        ? "Decisions and tasks are scattered across tools, making the next step unclear."
        : "Teams coordinating shared goals, decisions and delivery.",
    },
  };
  return discoveryView(
    {
      wiki: { installationId: "demo", hostname: null, slug: "onto", writable: false },
      records: [record],
      graph: { nodes: [record], edges: [], types: [] },
    },
    kind,
    url,
    recordId,
  );
}

/** Routes own the HTTP status; nested Astro components only render the result. */
export async function loadDiscoveryPage(
  context: {
    request: Request;
    locals: Parameters<typeof workflowHost>[0];
    url: URL;
  },
  kind: DiscoveryKind,
  demo: boolean,
  recordId = "",
) {
  try {
    if (!demo) requestIdentity(context.request);
    const page = demo
      ? demoDiscoveryPage(kind, requestPageURL(context.request), recordId)
      : await readDiscoveryPage(
          workflowHost<"interactive">(context.locals),
          kind,
          requestPageURL(context.request),
          recordId,
        );
    return {
      page,
      status: recordId && !page.records.length ? 404 : 200,
      error: "",
    };
  } catch (cause) {
    const status = cause instanceof Response ? cause.status : 503;
    return {
      page: undefined,
      status,
      error: [401, 403].includes(status)
        ? "You do not have access to this context."
        : "Unable to load this context. Try again later.",
    };
  }
}
