import type { EntityRecord, EntityRef } from "./entities";

export const graphMarkdownVersion = 2 as const;
export const graphMarkdownBytes = 48 * 1024;
export const graphReference = (ref: EntityRef) => `${ref.installationId}/${ref.type}/${ref.id}`;
export type GraphMarkdownNode = { record: EntityRecord; group: number; label: string };
export type GraphMarkdownEdge = { record: EntityRecord; label: string };
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const heading = (value: string) => value.replace(/[\r\n]/g, " ").replace(/[\\`*_{}[\]<>()#!|]/g, "\\$&");
const field = (key: string) => key.replaceAll("_", " ").replace(/^./, c => c.toUpperCase());
const bytes = (value: string) => new TextEncoder().encode(value).length;

// Values are authored data, never schema help or generated prose. Keep array
// order and multiline strings; sort object keys independently of query order.
function valueLines(value: unknown, indent = ""): string[] {
  if (Array.isArray(value) && !value.length) return [`${indent}[]`];
  if (Array.isArray(value)) return value.flatMap(item => {
    const lines = item === null ? [`${indent}  null`] : valueLines(item, `${indent}  `);
    return lines.length ? [`${indent}- ${lines[0].trimStart()}`, ...lines.slice(1)] : [];
  });
  if (value !== null && typeof value === "object" && !Object.keys(value).length) return [`${indent}{}`];
  if (value !== null && typeof value === "object") return Object.keys(value).sort(compare).flatMap(key => {
    const item = (value as Record<string, unknown>)[key];
    if (item === undefined) return [];
    if (item === null) return [`${indent}- ${heading(field(key))}: null`];
    if (typeof item === "object") return [`${indent}- ${heading(field(key))}:`, ...valueLines(item, `${indent}  `)];
    const [first, ...rest] = String(item).split("\n");
    return [`${indent}- ${heading(field(key))}: ${first}`, ...rest.map(line => `${indent}  ${line}`)];
  });
  return value === null || value === undefined ? [] : String(value).split("\n").map(line => `${indent}${line}`);
}

function recordFields(record: EntityRecord) {
  const a = record.attributes;
  const lines = [`- Reference: ${graphReference(record.ref)}`, `- Revision: ${record.revision}`];
  if (typeof a.typeId === "string") lines.push(`- Type: ${record.ref.installationId}/graph-type/${a.typeId}`);
  if (typeof a.slug === "string" && a.slug) lines.push(`- Slug: ${a.slug}`);
  const excluded = new Set(["id", "title", "slug", "typeId", "body", "provenance", "seedVersion", "archived"]);
  for (const key of Object.keys(a).sort(compare)) {
    if (!excluded.has(key) && a[key] !== null && a[key] !== "" && a[key] !== undefined)
      lines.push(...valueLines({ [key]: a[key] }));
  }
  if (typeof a.body === "string" && a.body) {
    let value: unknown = a.body;
    try { value = JSON.parse(a.body); } catch { /* Keep authored Markdown. */ }
    lines.push("", ...valueLines(value));
  }
  return lines;
}

function edgeFields(edge: GraphMarkdownEdge, installationId: string, present: Set<string>, excluded: Set<string>, omitted: Set<string>, incoming = false) {
  const target = String(edge.record.attributes[incoming ? "fromId" : "toId"]);
  const ref = { installationId, type: "graph-node", id: target };
  return [`- ${heading(edge.label)}${incoming ? " (incoming)" : ""}: ${graphReference(ref)}${present.has(target) ? "" : excluded.has(target) ? " (excluded by selection boundary)" : omitted.has(target) ? " (omitted by bounds)" : " (unresolved)"}`,
    `  - Relationship: ${graphReference(edge.record.ref)}`, `  - Revision: ${edge.record.revision}`,
    ...recordFields(edge.record).slice(2).map(line => `  ${line}`)];
}

function nodeSection(node: GraphMarkdownNode, edges: GraphMarkdownEdge[], present: Set<string>, excluded: Set<string>, omitted: Set<string>, sourcePresent = present) {
  const { record, group, label } = node;
  return [`${group === 0 ? "#" : "##"} ${heading(label)}: ${heading(record.title)}`,
    ...recordFields(record),
    ...edges.filter(e => e.record.attributes.fromId === record.ref.id || (e.record.attributes.toId === record.ref.id && !sourcePresent.has(String(e.record.attributes.fromId))))
      .flatMap(edge => edgeFields(edge, record.ref.installationId, present, excluded, omitted, edge.record.attributes.fromId !== record.ref.id)), "", ""].join("\n");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort(compare).map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function unique<T extends { record: EntityRecord }>(values: T[]) {
  const records = new Map<string, T>();
  for (const value of values) {
    const key = graphReference(value.record.ref);
    const prior = records.get(key);
    if (prior && canonical(prior) !== canonical(value))
      throw new Error("Conflicting graph revisions");
    records.set(key, value);
  }
  return [...records.values()];
}

function renderBoundedSections(retained: GraphMarkdownNode[], edges: GraphMarkdownEdge[], excludedIds: Set<string>, omitted: EntityRef[], limit: number) {
  const render = () => {
    const rendered = new Set(retained.map(node => node.record.ref.id));
    const omittedReferences = new Set(omitted.map(ref => ref.id));
    return retained.map(node => nodeSection(node, edges, rendered, excludedIds, omittedReferences)).join("");
  };
  let markdown = render();
  // A removed source can move its relationship under the retained target.
  // Preserve whole records and make room for that incoming evidence as needed.
  while (bytes(markdown) > limit - 256 && retained.length) {
    const removed = retained.pop();
    if (removed) omitted.push(removed.record.ref);
    markdown = render();
  }
  return markdown;
}

/** Pure fact rendering. Selection and authorization belong to the caller. */
export function renderGraphMarkdown(input: {
  nodes: GraphMarkdownNode[]; edges: GraphMarkdownEdge[];
  omitted?: EntityRef[]; unresolved?: EntityRef[]; excluded?: EntityRef[]; unmaterialized?: boolean; incomplete?: boolean; maxBytes?: number;
}) {
  const limit = Math.min(input.maxBytes ?? graphMarkdownBytes, graphMarkdownBytes);
  if (limit < 512) throw new Error("Graph document budget is too small");
  const nodes = unique(input.nodes).sort((a, b) => a.group - b.group || compare(graphReference(a.record.ref), graphReference(b.record.ref)));
  const edges = unique(input.edges).sort((a, b) => compare(graphReference(a.record.ref), graphReference(b.record.ref)));
  const excluded = [...(input.excluded ?? [])].sort((a, b) => compare(graphReference(a), graphReference(b)));
  const excludedIds = new Set(excluded.map(ref => ref.id));
  const omittedIds = new Set((input.omitted ?? []).map(ref => ref.id));
  const present = new Set(nodes.map(n => n.record.ref.id));
  const missing = [...(input.unresolved ?? []), ...edges.flatMap(e => [e.record.attributes.fromId,e.record.attributes.toId]
    .map(String).filter(id => !present.has(id) && !excludedIds.has(id) && !omittedIds.has(id))
    .map(id => ({ installationId: e.record.ref.installationId, type: "graph-node", id })))];
  const unresolved = [...new Map(missing.map(ref => [graphReference(ref), ref])).values()]
    .sort((a, b) => compare(graphReference(a), graphReference(b)));
  const omitted: EntityRef[] = [...(input.omitted ?? [])].sort((a, b) => compare(graphReference(a), graphReference(b)));
  // Reserve the worst-case relationship labels before choosing whole sections.
  // Count each relationship once; recheck incoming boundary evidence after omissions.
  const boundedIds = new Set([...nodes.map(node => node.record.ref.id), ...omittedIds]);
  const retained: GraphMarkdownNode[] = [];
  let reserved = 0;
  for (const node of nodes) {
    const size = bytes(nodeSection(node, edges, new Set(), excludedIds, boundedIds, present));
    if (reserved + size > limit - 256) omitted.push(node.record.ref);
    else { retained.push(node); reserved += size; }
  }
  let markdown = renderBoundedSections(retained, edges, excludedIds, omitted, limit);
  const complete = !input.unmaterialized && !input.incomplete && !omitted.length && !unresolved.length && !excluded.length;
  markdown += `- Complete: ${complete}\n- Omitted records: ${omitted.length}\n- Unresolved references: ${unresolved.length}\n- Excluded references: ${excluded.length}\n`;
  if (input.unmaterialized) markdown += "- Occurrence: unresolved (not yet materialized)\n";
  const sources = [...nodes.map(n => n.record), ...edges.map(e => e.record)]
    .map(record => ({ ref: record.ref, revision: record.revision }))
    .sort((a, b) => compare(graphReference(a.ref), graphReference(b.ref)));
  return { rendererVersion: graphMarkdownVersion, mediaType: "text/markdown" as const, markdown, sources, complete, omitted, unresolved, excluded, unmaterialized: input.unmaterialized ?? false };
}

/** Default factual template for a Wiki selection. Apps needing another grouping
 * use renderGraphMarkdown with their own labels; retrieval stays independent. */
export function renderKnowledgeGraphMarkdown(graph: {
  types: EntityRecord[]; nodes: EntityRecord[]; edges: EntityRecord[];
  roots?: EntityRef[]; omitted?: EntityRef[]; unresolved?: EntityRef[]; incomplete?: boolean;
}) {
  const types = new Map(graph.types.map(type => [type.ref.id, type]));
  const roots = new Set(graph.roots?.map(graphReference));
  const label = (record: EntityRecord) => {
    const type = types.get(String(record.attributes.typeId));
    return type ? String(type.attributes.title || type.attributes.name || type.title) : "Unresolved type";
  };
  const output = renderGraphMarkdown({
    nodes: graph.nodes.map(record => ({ record, group: roots.has(graphReference(record.ref)) ? 0 : 1, label: label(record) })),
    edges: graph.edges.map(record => ({ record, label: label(record) })),
    omitted: graph.omitted, unresolved: graph.unresolved, incomplete: graph.incomplete,
  });
  const usedTypes = new Set([...graph.nodes, ...graph.edges].map(record => String(record.attributes.typeId)));
  output.sources.push(...graph.types.filter(type => usedTypes.has(type.ref.id)).map(type => ({ ref: type.ref, revision: type.revision })));
  output.sources.sort((a,b) => compare(graphReference(a.ref),graphReference(b.ref)));
  return output;
}
