import { graphChangeInput } from "@ai-outfitter/app-sdk/graph-contracts";
import { z } from "zod";
import { nodeAddress } from "../lib/addresses";
import type { Graph } from "../lib/graph";

export const operationSchema = graphChangeInput.shape.operations.element;
export const suggestionFields = {
  anchors: z.array(z.string().trim().min(1).max(300)).min(1).max(20),
  quote: z.string().min(1).max(1200),
  reason: z.string().max(1000),
};
export const plan = z.object({
  ...suggestionFields,
  operations: z.array(operationSchema).min(1).max(8),
  evidence: z.object({
    provider: z.literal("wiki"), recordId: z.string().max(500), version: z.string(),
    quote: z.string(), contentHash: z.string(),
  }).nullable(),
});
export const normal = (value: string | null | undefined) => (value ?? "").normalize("NFKC").trim().toLowerCase();

export function graphAnchors(graph: Graph) {
  const types = new Map(graph.types.filter(type => !type.archived && type.category === "node").map(type => [type.id, type.name]));
  return graph.nodes.flatMap(node => {
    const type = types.get(node.typeId);
    return !node.archived && type && node.slug ? [{ node, address: nodeAddress(type, node.slug) }] : [];
  });
}

type Operation = z.infer<typeof operationSchema>;
type Resolution = { issue: string } | { anchors: string[]; operations: Operation[] };
function mentionsAlias(text: string, alias: string) {
  if (!alias) return false;
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, "u").test(text);
}

export function resolvePassage(graph: Graph, item: z.infer<typeof plan>): Resolution {
  const active = graphAnchors(graph);
  const anchors = new Map<string, typeof active[number]>();
  const mentions = new Map<string, string>();
  for (const mention of item.anchors) {
    const handle = normal(mention);
    const matches = handle.includes(":")
      ? active.filter(value => normal(value.address) === handle)
      : active.filter(({ node }) => normal(node.title) === handle || normal(node.slug) === handle);
    if (matches.length !== 1)
      return { issue: matches.length ? `Ambiguous anchor: ${mention}` : `Missing anchor: ${mention}` } as const;
    anchors.set(matches[0].address, matches[0]);
    mentions.set(handle, matches[0].address);
  }

  const excerpt = normal(item.quote);
  for (const { node, address } of anchors.values()) {
    const title = normal(node.title), slug = normal(node.slug);
    if (mentionsAlias(excerpt, normal(address))) continue;
    if (mentionsAlias(excerpt, slug) && active.filter(item => normal(item.node.slug) === slug).length === 1 &&
      (slug !== title || active.filter(item => normal(item.node.title) === title).length === 1)) continue;
    if (mentionsAlias(excerpt, title)) {
      if (active.filter(item => normal(item.node.title) === title).length === 1) continue;
      return { issue: `Ambiguous anchor: ${node.title}` };
    }
    return { issue: `Anchor is not named in the evidence quote: ${address}` };
  }

  const addressOf = (value: unknown) => {
    if (typeof value !== "string") return;
    const handle = normal(value);
    return mentions.get(handle) ?? [...anchors.keys()].find(address => normal(address) === handle);
  };
  const invalid = { issue: "The proposed operation does not match the resolved anchors or revisions" };
  const created = new Set(item.operations.filter(operation =>
    operation.type === "graph-node" && operation.operation === "create").map(operation => operation.ref));
  const seen = new Set<string>();
  const touched = new Set<string>();
  const connected = new Set<string>();
  const operations: Operation[] = [];
  for (const operation of item.operations) {
    const { attributes } = operation;
    const fields = Object.keys(attributes);
    if (seen.has(operation.ref)) return invalid;
    seen.add(operation.ref);
    if (operation.type === "graph-node" && operation.operation === "update") {
      const target = addressOf(operation.id);
      if (!target || anchors.get(target)?.node.revision !== operation.revision || !fields.length ||
        !fields.every(field => ["summary", "body", "website", "properties"].includes(field))) return invalid;
      touched.add(target);
      operations.push({ ...operation, id: target });
    } else if (operation.type === "graph-node" && operation.operation === "create") {
      const title = typeof attributes.title === "string" ? normal(attributes.title) : "";
      if (!mentionsAlias(excerpt, title) || active.some(({ node }) =>
        normal(node.title) === title || normal(node.slug) === title) ||
        !fields.every(field => ["typeId", "title", "summary", "body", "website", "properties"].includes(field))) return invalid;
      operations.push(operation);
    } else if (operation.type === "graph-edge" && operation.operation === "create") {
      const endpoint = (value: unknown) => addressOf(value) ?? (typeof value === "string" && created.has(value) ? value : undefined);
      const from = endpoint(attributes.fromId);
      const to = endpoint(attributes.toId);
      const type = graph.types.find(type => !type.archived && type.category === "edge" && type.name === attributes.typeId);
      if (!type || !from || !to ||
        !fields.every(field => ["typeId", "fromId", "toId", "title", "body", "properties", "validity"].includes(field))) return invalid;
      const existing = graph.edges.some(edge => !edge.archived && edge.typeId === type.id &&
        edge.fromId === anchors.get(from)?.node.id && edge.toId === anchors.get(to)?.node.id &&
        (edge.validity?.from ?? null) === (z.object({ from: z.string().nullish() }).safeParse(attributes.validity).data?.from ?? null));
      if (existing) return { issue: "The proposed relationship already exists" };
      if (anchors.has(from)) touched.add(from);
      if (anchors.has(to)) touched.add(to);
      if (anchors.has(from) && created.has(to)) connected.add(to);
      if (anchors.has(to) && created.has(from)) connected.add(from);
      operations.push({ ...operation, attributes: { ...attributes, fromId: from, toId: to } });
    } else {
      return invalid;
    }
  }
  // Each named anchor participates, and every introduced node directly connects to one.
  if (touched.size !== anchors.size || connected.size !== created.size) return invalid;
  return { anchors: [...anchors.keys()], operations };
}
