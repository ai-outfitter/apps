import { z } from "zod";
import { endpointAllows, wikiGraph, type WikiGraph } from "./graph-contracts";
import { stableGraphId } from "./graph-client";

type Type = WikiGraph["types"][number];
type Node = WikiGraph["nodes"][number];
type Edge = WikiGraph["edges"][number];
type Authored<T> = Partial<T> & { aliases?: string[] };

export type AuthoredGraph = {
  namespace: string;
  types?: Authored<Type>[];
  nodes?: Authored<Node>[];
  edges?: (Partial<Edge> & { key?: string })[];
};

const namespacePattern = /^[a-z][a-z0-9-]*$/;
const typePattern = /^[A-Za-z][A-Za-z0-9_]*$/;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const edgeKeyPattern = /^[a-z0-9][a-z0-9_-]*$/;
const uuid = z.uuid();
const typeSchema = wikiGraph.shape.types.element;
const nodeSchema = wikiGraph.shape.nodes.element;
const edgeSchema = wikiGraph.shape.edges.element;

function add<T>(index: Map<string, T>, key: string, value: T, context: string) {
  if (index.has(key)) throw Error(`Duplicate ${context}: ${key}`);
  index.set(key, value);
}

async function recordId(id: unknown, key: string) {
  return id === undefined ? stableGraphId("outfitter.authored-graph.v1", key) : uuid.parse(id);
}

/**
 * Resolve authored references in two passes, independently of declaration order.
 * Prefix a type name with its owning namespace, or a node address with the
 * namespace of the file that defines that node. UUID references remain readable
 * for ports from existing seed graphs. An explicit record ID is a compatibility
 * pin and must remain unchanged when its authored address moves.
 */
export async function compileAuthoredGraphs(inputs: readonly AuthoredGraph[]) {
  const records = new Map<string, string>();
  const typeIds = new Map<string, string>();
  const typeAddresses = new Map<string, { id: string; category?: Type["category"] }>();
  const nodeAddresses = new Map<string, string>();
  const nodes = new Map<string, Node>();
  const typeRecords = new Map<string, Type>();
  const edgeAddresses = new Set<string>();
  const types = [];
  const pendingNodes = [];
  const pendingEdges = [];
  const graphs = inputs.map((): WikiGraph => ({ types: [], nodes: [], edges: [] }));

  for (const [index, source] of inputs.entries()) {
    const { namespace } = source;
    if (!namespacePattern.test(namespace)) throw Error(`Invalid graph namespace: ${namespace}`);
    for (const { id: savedId, aliases = [], ...type } of source.types ?? []) {
      if (!type.name || !typePattern.test(type.name)) throw Error(`Invalid type name in ${namespace}`);
      const address = `${namespace}:${type.name}`;
      const id = await recordId(savedId, `type:${address}`);
      add(records, id, address, "record identity");
      add(typeIds, type.name, id, "public type name");
      const entry = { id, category: type.category };
      add(typeAddresses, id, entry, "type identity");
      add(typeAddresses, address, entry, "type address");
      for (const alias of aliases) {
        if (!typePattern.test(alias)) throw Error(`Invalid type alias: ${namespace}:${alias}`);
        add(typeAddresses, `${namespace}:${alias}`, entry, "type address or alias");
      }
      types.push({ index, address, id, type });
    }
    for (const node of source.nodes ?? []) pendingNodes.push({ index, namespace, node });
    for (const edge of source.edges ?? []) pendingEdges.push({ index, namespace, edge });
  }

  function typeRef(ref: string | undefined, category: Type["category"], context: string) {
    const entry = typeAddresses.get(ref ?? "");
    if (!entry) throw Error(`Unresolved ${category} type ${ref} in ${context}`);
    if (entry.category !== category) throw Error(`Expected ${category} type ${ref} in ${context}`);
    return entry.id;
  }

  for (const { index, address, id, type } of types) {
    const contract = type.ontology;
    const side = (value: "any" | string[]) => value === "any" ? value : value.map(ref => typeRef(ref, "node", address));
    const next = typeSchema.parse({
      ...type, id,
      ...(contract && { ontology: {
        ...contract,
        ...(contract.endpoints && { endpoints: { from: side(contract.endpoints.from), to: side(contract.endpoints.to) } }),
        ...(contract.version === 2 && contract.participation && { participation: {
          ...contract.participation,
          slots: contract.participation.slots.map(slot => ({ ...slot, edgeTypeId: typeRef(slot.edgeTypeId, "edge", address),
            participantTypes: slot.participantTypes.map(ref => typeRef(ref, "node", address)) })),
        } }),
        ...(contract.version === 2 && contract.projection && { projection: {
          ...contract.projection, relatorTypeId: typeRef(contract.projection.relatorTypeId, "node", address),
        } }),
      } }),
    });
    typeRecords.set(id, next);
    graphs[index].types.push(next);
  }

  const publicNodes = new Map<string, string>();
  for (const { index, namespace, node: { id: savedId, aliases = [], ...node } } of pendingNodes) {
    const typeId = typeRef(node.typeId, "node", node.slug ?? String(savedId));
    const type = typeRecords.get(typeId)!;
    if (!node.slug || !slugPattern.test(node.slug)) throw Error(`Expected node slug in ${namespace}:${type.name}`);
    const publicAddress = `${type.name}:${node.slug}`;
    const address = `${namespace}:${publicAddress}`;
    const id = await recordId(savedId, `node:${address}`);
    add(records, id, address, "record identity");
    add(publicNodes, publicAddress, id, "public node address");
    add(nodeAddresses, id, id, "node identity");
    add(nodeAddresses, address, id, "node address");
    for (const alias of aliases) {
      if (!slugPattern.test(alias)) throw Error(`Invalid node alias: ${address} / ${alias}`);
      add(nodeAddresses, `${namespace}:${type.name}:${alias}`, id, "node address or alias");
    }
    const next = nodeSchema.parse({ ...node, id, typeId });
    nodes.set(id, next);
    graphs[index].nodes.push(next);
  }

  for (const { index, namespace, edge: { id: savedId, key, ...edge } } of pendingEdges) {
    if (key !== undefined) {
      if (!edgeKeyPattern.test(key)) throw Error(`Invalid edge key: ${namespace}:${key}`);
      if (edgeAddresses.has(`${namespace}:${key}`)) throw Error(`Duplicate edge key: ${namespace}:${key}`);
      edgeAddresses.add(`${namespace}:${key}`);
    }
    if (!savedId && !key) throw Error(`Expected an edge key in ${namespace}`);
    const address = `${namespace}:${key ?? savedId}`;
    const typeId = typeRef(edge.typeId, "edge", address);
    const type = typeRecords.get(typeId)!;
    const fromId = nodeAddresses.get(edge.fromId ?? "");
    const toId = nodeAddresses.get(edge.toId ?? "");
    if (!fromId || !toId) throw Error(`Unresolved directed endpoint ${!fromId ? edge.fromId : edge.toId} in ${address}`);
    const contract = type.ontology?.endpoints;
    if (contract && (!endpointAllows(contract.from, nodes.get(fromId)!.typeId) || !endpointAllows(contract.to, nodes.get(toId)!.typeId)))
      throw Error(`Invalid directed endpoints for ${type.name} in ${address}`);
    const id = await recordId(savedId, `edge:${address}`);
    add(records, id, address, "record identity");
    graphs[index].edges.push(edgeSchema.parse({ ...edge, id, typeId, fromId, toId }));
  }
  return graphs;
}

/** One app-authored contribution. Standard rows are installed by Onto; add-ons
 * retain their owning app's setup lifecycle. Fixture records ship separately. */
export type GraphContribution = {
  name: string;
  scope: "standard" | "addon" | "fixture";
  types?: AuthoredGraph["types"];
  nodes?: AuthoredGraph["nodes"];
  edges?: AuthoredGraph["edges"];
  projects?: AuthoredGraph["nodes"];
  format?: string;
  /** Fixtures with an independent record store share only the standard types. */
  isolated?: boolean;
  /** A historic add-on registry can replace only the specific contributions it shipped before. */
  legacyAlternatives?: string[];
};
