import { loadKnowledgeGraph, exploreKnowledgeGraph } from "./knowledge-graph";
import { wikiGraphReadInput, wikiGraphReadResult } from "./wiki-graph";
import { z } from "zod";
import { discoverEntityTypes } from "./entity-discovery";
export * from "./ontology-measures";
/** @deprecated Import contracts from @ai-outfitter/onto/contracts and clients from @ai-outfitter/onto/client. */
export * from "@ai-outfitter/onto-contracts";
import { wikiGraph, type WikiGraph } from "@ai-outfitter/onto-contracts";
import type { WorkflowHost } from "./workflow-host";
import { entityRef, type EntityRecord, type EntityRef } from "./entities";

type Host = WorkflowHost<"interactive">;
async function existingRecord(host: Host, ref: EntityRef) {
  try {
    return await host.call("entities.get", ref);
  } catch (error) {
    if (error instanceof Response && error.status === 404) return undefined;
    throw error;
  }
}
async function createRecord(
  host: Host,
  ref: EntityRef,
  attributes: EntityRecord["attributes"],
) {
  try {
    const record = await host.call("entities.create", {
      installationId: ref.installationId,
      type: ref.type,
      attributes,
    });
    return { record, created: true };
  } catch (error) {
    if (!(error instanceof Response && error.status === 409)) throw error;
    const record = await existingRecord(host, ref);
    if (!record)
      throw new Response(
        `Cannot set up ${ref.type}/${ref.id}: its name or address belongs to another record`,
        { status: 409 },
      );
    return { record, created: false };
  }
}

type SetupRow = {
  type: string;
  fields: EntityRecord["attributes"] & { id: string };
  identityKeys: readonly string[];
};
async function ensureRecord(
  host: Host,
  installationId: string,
  { type, fields, identityKeys }: SetupRow,
) {
  const ref = { installationId, type, id: fields.id };
  const previous = await existingRecord(host, ref);
  const { record, created } = previous
    ? { record: previous, created: false }
    : await createRecord(host, ref, fields);
  if (
    record.ref.id !== fields.id ||
    identityKeys.some((key) => record.attributes[key] !== fields[key])
  )
    throw new Response(`Existing graph record ${type}:${fields.id} has a conflicting identity (${identityKeys.filter(key => record.attributes[key] !== fields[key]).join(", ")})`, {
      status: 409,
    });
  return created;
}
function setupRows(graph: WikiGraph): SetupRow[] {
  const groups = [
    ["graph-type", graph.types, ["category", "name"]],
    ["graph-node", graph.nodes, ["typeId"]],
    ["graph-edge", graph.edges, ["typeId", "fromId", "toId"]],
  ] as const;
  return groups.flatMap(([type, rows, identityKeys]) => {
    if (new Set(rows.map((row) => row.id)).size !== rows.length)
      throw new Error("Duplicate graph setup ID");
    return rows.map((fields) => ({ type, fields, identityKeys }));
  });
}
/** A UUID-shaped ID derived from `parts`: the same parts always name the same record. */
export async function stableGraphId(...parts: unknown[]) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(parts))));
  const hex = Array.from(digest, (n) => n.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** An app-neutral adapter over the existing scope-checked entity host. Setup is add-only. */
export function wikiAdapter(host: Host, installationId: string) {
  const ref = (type: string, id: string) => ({ installationId, type, id });
  return {
    /** The record, or undefined when it does not exist. */
    get: (type: "graph-node" | "graph-edge" | "graph-type", id: string) => existingRecord(host, ref(type, id)),
    /** Create a record with a caller-chosen ID; a concurrent or earlier create returns the existing record. */
    async createOrRead(type: "graph-node" | "graph-edge", attributes: EntityRecord["attributes"] & { id: string }, references: EntityRef[] = []) {
      const existing = await existingRecord(host, ref(type, attributes.id));
      if (existing) return existing;
      try {
        return await host.call("entities.create", { installationId, type, attributes, references });
      } catch (error) {
        const record = error instanceof Response && error.status === 409 ? await existingRecord(host, ref(type, attributes.id)) : undefined;
        if (!record) throw error;
        return record;
      }
    },
    /** One relationship per type and endpoints, with a stable ID; refuses an archived or different record there. */
    async link(typeId: string, fromId: string, toId: string) {
      const id = await stableGraphId("wiki-link-v1", installationId, typeId, fromId, toId);
      const record = await this.createOrRead("graph-edge", { id, typeId, fromId, toId });
      const { attributes } = record;
      if (attributes.archived || attributes.typeId !== typeId || attributes.fromId !== fromId || attributes.toId !== toId)
        throw new Response("A relationship conflicts with an authored or archived record", { status: 409 });
      return record;
    },
    /** Active type IDs by name. */
    async typeIds() {
      const ids = new Map<string, string>();
      for (let offset = 0; offset < 10_000; offset += 100) {
        const page = await host.call("entities.list", { installationId, type: "graph-type", offset, limit: 100 });
        for (const type of page) if (!type.attributes.archived) ids.set(String(type.attributes.name), type.ref.id);
        if (page.length < 100) return ids;
      }
      throw new Response("Wiki has too many types", { status: 413 });
    },
    async setup(input: WikiGraph) {
      const rows = setupRows(wikiGraph.parse(input));
      const result = { created: 0, existing: 0 };
      for (const row of rows) {
        const created = await ensureRecord(host, installationId, row);
        result[created ? "created" : "existing"]++;
      }
      return result;
    },
  };
}

/** Shared route naming for Wiki types; keeps existing node URLs stable. */
export const typeSegment = (name: string) => {
  const singular = name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replaceAll("_", "-")
    .toLowerCase();
  if (singular === "person") return "people";
  if (/[^aeiou]y$/.test(singular)) return `${singular.slice(0, -1)}ies`;
  return /(?:s|x|ch|sh)$/.test(singular) ? `${singular}es` : `${singular}s`;
};

// WorkflowHost capabilities are created for each dispatch. Key by that object,
// never an installation/user ID, so another request always rechecks authority.
const wikiContexts = new WeakMap<
  Host,
  Promise<Awaited<ReturnType<typeof discoverWiki>>>
>();

/** The owner's single graph Wiki, discovered once per request-scoped host.
 * Failed discovery is retryable; entity operations still check current access. */
export function defaultWiki(host: Host) {
  const existing = wikiContexts.get(host);
  if (existing) return existing;
  const pending = discoverWiki(host).catch((error) => {
    wikiContexts.delete(host);
    throw error;
  });
  wikiContexts.set(host, pending);
  return pending;
}

async function discoverWiki(host: Host) {
  const providers = await discoverEntityTypes(host, { template: "wiki-map" });
  const candidates = providers.filter(
    (p) =>
      p.type === "graph-type" &&
      ["graph-node", "graph-edge"].every((type) =>
        providers.some(
          (other) =>
            other.installationId === p.installationId && other.type === type,
        ),
      ),
  );
  if (candidates.length !== 1)
    throw new Response("The app requires one installed Wiki for its owner", {
      status: 409,
    });
  const wiki = candidates[0];
  return {
    installationId: wiki.installationId,
    hostname: wiki.hostname ?? null,
    /** Its address segment: `/apps/<slug>/` for a person's Wiki. */
    slug: wiki.slug ?? "wiki-map",
    writable: ["graph-type", "graph-node", "graph-edge"].every((type) =>
      providers.some(
        (p) =>
          p.installationId === wiki.installationId &&
          p.type === type &&
          p.writable,
      ),
    ),
  };
}

/** Read the owner's graph through one scoped Wiki action. Formatting remains with callers.
 * Archived metadata is opt-in; records and authority are re-read on every call. */
export async function readWikiGraph(
  host: Host,
  options: z.input<typeof wikiGraphReadInput> = {},
) {
  const input = wikiGraphReadInput.parse(options);
  const wiki = await defaultWiki(host);
  const snapshot = wikiGraphReadResult.parse(await host.call("actions.call", {
    installationId: wiki.installationId, action: "graph.read", input, readOnly: true, maxResponseBytes: 8 * 1024 * 1024,
  }));
  if (snapshot.installationId !== wiki.installationId)
    throw new Response("Wiki installation changed", { status: 409 });
  if (snapshot.truncated || snapshot.selection !== null)
    throw new Response("Wiki returned a partial graph; refresh before using it", { status: 409 });
  return { wiki, snapshot, ...wikiGraphRecords(snapshot, "includeArchivedTypes" in input && !!input.includeArchivedTypes) };
}

/** Convert a Wiki snapshot to canonical entity records without fetching or formatting. */
export function wikiGraphRecords(snapshot: Pick<z.infer<typeof wikiGraphReadResult>, "installationId" | "types" | "nodes" | "edges">, includeArchivedTypes = false) {
  function records(type: string, rows: Array<typeof snapshot.nodes[number] | typeof snapshot.types[number]>): EntityRecord[] {
    return rows.map(row => {
      const { id, revision, createdBy, updatedBy, createdAt, updatedAt, ...attributes } = row;
      return {
        ref: { installationId: snapshot.installationId, type, id }, revision,
        title: String(row.title ?? row.name ?? id),
        attributes: { id, ...attributes, provenance: { createdBy: createdBy ?? null, updatedBy: updatedBy ?? null, createdAt: createdAt ?? null, updatedAt: updatedAt ?? null } },
        references: row.source ? [entityRef.parse(row.source)] : [],
      };
    });
  }
  return {
    types: records("graph-type", snapshot.types.filter(row => includeArchivedTypes || !row.archived)),
    nodes: records("graph-node", snapshot.nodes),
    edges: records("graph-edge", snapshot.edges),
  };
}

/** Select a saved lens from a graph already read through Wiki. No additional I/O. */
export function selectWikiGraph(
  graph: { types: EntityRecord[]; nodes: EntityRecord[]; edges: EntityRecord[] },
  input: { rootId: string; lensId: string; allowedNodeIds?: ReadonlySet<string>; priorityNodeIds?: ReadonlySet<string> },
) {
  const rawNode = (record: EntityRecord) => ({ ...record.attributes, id: record.ref.id, typeId: String(record.attributes.typeId) });
  const types = graph.types.map(record => ({ id: record.ref.id, name: String(record.attributes.name), category: record.attributes.category as "node" | "edge", archived: !!record.attributes.archived }));
  const lens = graph.nodes.find(record => record.ref.id === input.lensId && !record.attributes.archived);
  const root = graph.nodes.find(record => record.ref.id === input.rootId && !record.attributes.archived);
  if (!lens || !root || !types.some(type => type.id === lens.attributes.typeId && type.name === "KnowledgeGraph"))
    throw new Response("Knowledge graph or root not found", { status: 409 });
  let definition;
  try { definition = loadKnowledgeGraph({ types }, rawNode(lens)); }
  catch { throw new Response("Knowledge graph definition is invalid", { status: 409 }); }
  if (!definition.rootTypes.includes(String(root.attributes.typeId)))
    throw new Response("Context lens does not match its root", { status: 409 });
  const selected = exploreKnowledgeGraph({ nodes: graph.nodes.map(rawNode), edges: graph.edges.map(record => ({ ...record.attributes, id: record.ref.id,
    typeId: String(record.attributes.typeId), fromId: String(record.attributes.fromId), toId: String(record.attributes.toId) })) }, rawNode(root), definition, { allowedNodeIds: input.allowedNodeIds, priorityNodeIds: input.priorityNodeIds });
  const nodeIds = new Set(selected.nodes.map(node => node.id)), edgeIds = new Set(selected.edges.map(edge => edge.id));
  return { ...selected, lens, missingTypes: definition.missingTypes,
    nodes: graph.nodes.filter(record => nodeIds.has(record.ref.id)), edges: graph.edges.filter(record => edgeIds.has(record.ref.id)) };
}
