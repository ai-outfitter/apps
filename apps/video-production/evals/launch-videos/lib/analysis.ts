// What a launch-video run staged in Onto, read from the run's Onto tables, and how its
// new types compare with the reference answer: Video production's own ontology
// (src/server/onto.ts). Names may differ; the shape may not: a storyboard type, a
// shot type with order and duration properties, and a typed shot → storyboard relationship.
import type { Row, Run } from "./run";

export type Operation = { operation: string; ref: string; type: "graph-type" | "graph-node" | "graph-edge"; attributes: Record<string, unknown> };
export type ProposedType = { name: string; category: string; properties: { name: string; type?: string }[]; endpoints: { from: string[]; to: string[] } | null };

const json = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;

/** Order and timing written into a title: "01 — Hook", "Find your spot (15s)". */
export const timingInTitle = /^\s*\d+\s*[—–\-:.]|\(\s*\d+\s*s(ec(onds?)?)?\s*\)/i;
const orderProperty = /^(sequence|order|position|index|shot_?(number|no|order|index)|number|seq)$/i;
const durationProperty = /duration|length|seconds|runtime/i;

export function analyze(run: Run) {
  const table = (when: "before" | "after", name: string): Row[] => run.onto[when][name] ?? [];
  const before = new Set(table("before", "graph_batches").map((row) => row.id));
  const batches = table("after", "graph_batches").filter((row) => !before.has(row.id));
  const batchIds = new Set(batches.map((row) => row.id));
  const operations = table("after", "graph_batch_operations")
    .filter((row) => batchIds.has(row.batchId) && row.state !== "rejected")
    .map((row) => json<Operation>(row.operation));

  // Type names by every handle an operation may use: id, name or a ref staged in the batch.
  const names = new Map<string, string>();
  for (const row of table("after", "graph_types")) {
    names.set(String(row.id), String(row.name));
    names.set(String(row.name), String(row.name));
  }
  for (const op of operations) if (op.type === "graph-type") {
    names.set(op.ref, String(op.attributes.name));
    if (op.attributes.id) names.set(String(op.attributes.id), String(op.attributes.name));
  }
  const nameOf = (handle: unknown) => names.get(String(handle)) ?? names.get(String(handle).replace(/^\$/, "")) ?? String(handle);
  const endpoints = (ontology: unknown) => {
    const sides = json<{ endpoints?: { from?: unknown; to?: unknown } } | null>(ontology)?.endpoints;
    const side = (value: unknown) => (Array.isArray(value) ? value.map(nameOf) : []);
    return sides ? { from: side(sides.from), to: side(sides.to) } : null;
  };

  // Types this run introduced, staged or already saved.
  const known = new Set(table("before", "graph_types").map((row) => String(row.name)));
  const found = new Map<string, ProposedType>();
  for (const op of operations)
    if (op.type === "graph-type" && op.operation === "create")
      found.set(String(op.attributes.name), { name: String(op.attributes.name), category: String(op.attributes.category), properties: json(op.attributes.properties ?? []), endpoints: endpoints(op.attributes.ontology) });
  for (const row of table("after", "graph_types"))
    if (!known.has(String(row.name)) && !found.has(String(row.name)))
      found.set(String(row.name), { name: String(row.name), category: String(row.category), properties: json(row.properties ?? []), endpoints: endpoints(row.ontology) });
  const newTypes = [...found.values()];
  const fresh = new Set(newTypes.map((type) => type.name));

  const created = operations.filter((op) => op.type === "graph-node" && op.operation === "create");
  const typedRecords = created.filter((op) => fresh.has(nameOf(op.attributes.typeId)));
  const documents = created.filter((op) => nameOf(op.attributes.typeId) === "Document");

  // The shape. A shot type has an order and a duration property; a storyboard type is
  // what a new relationship type leads to from shots, by its endpoints or by the
  // relationships the run staged.
  const nodeTypes = newTypes.filter((type) => type.category === "node");
  const shots = nodeTypes.filter((type) =>
    type.properties.some((p) => orderProperty.test(p.name)) && type.properties.some((p) => durationProperty.test(p.name) && !/^start/i.test(p.name)));
  const nodeType = new Map<string, string>();
  for (const op of created) {
    nodeType.set(op.ref, nameOf(op.attributes.typeId));
    if (op.attributes.id) nodeType.set(String(op.attributes.id), nameOf(op.attributes.typeId));
  }
  for (const row of table("after", "graph_nodes")) nodeType.set(String(row.id), nameOf(row.typeId));
  const staged = operations.filter((op) => op.type === "graph-edge" && op.operation === "create")
    .map((op) => ({ type: nameOf(op.attributes.typeId), from: nodeType.get(String(op.attributes.fromId)), to: nodeType.get(String(op.attributes.toId)) }));
  const shotLinks = newTypes.filter((type) => type.category === "edge").flatMap((type) => shots.flatMap((shot) => {
    const declared = type.endpoints?.from.includes(shot.name) ? type.endpoints.to : [];
    const used = staged.filter((edge) => edge.type === type.name && edge.from === shot.name).map((edge) => edge.to ?? "");
    return [...new Set([...declared, ...used])].filter((to) => to !== shot.name && nodeTypes.some((node) => node.name === to))
      .map((storyboard) => ({ shot: shot.name, storyboard, relationship: type.name }));
  }));

  return { batches, operations, newTypes, typedRecords, documents, nameOf, shape: shotLinks[0] ?? null, shots: shots.map((type) => type.name) };
}

/** The reference answer, as the run report prints it beside what the run proposed. */
export const reference = {
  storyboard: "Storyboard (duration_seconds, aspect_ratio, variant, opening, status)",
  shot: "Shot (sequence, start_seconds, duration_seconds, beat, action, camera, voiceover, overlay, sound, transition, source_route, claim_status, status)",
  relationship: "shot_of: Shot → Storyboard",
  others: "CreativeBrief, VisualReference; promotes, follows_brief, uses_reference, cut_from",
};
