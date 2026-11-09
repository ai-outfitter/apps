// Naming and layout of the generated GraphQL schema, computed from type rows
// alone. See graph-graphql.ts for the rules; this file only applies them.
import type { OntologyV2 } from "./graph-contracts/index";
import { compareIds } from "./graph-graphql-source";

/** A Wiki type row as graph.query returns it in fields:"full" (extra keys ignored). */
export type TypeRow = Record<string, unknown> & { id: string; name: string; category: "node" | "edge" };
type Property = { name: string; type?: string };
type Slot = NonNullable<OntologyV2["participation"]>["slots"][number];

const words = (name: string) => name.split(/[^A-Za-z0-9]+/).filter(Boolean);
const typeName = (name: string) => {
  const cleaned = words(name).map(word => word[0].toUpperCase() + word.slice(1)).join("");
  return /^[A-Za-z]/.test(cleaned) ? cleaned : `T${cleaned}`;
};
const fieldName = (name: string) => { const pascal = typeName(name); return pascal[0].toLowerCase() + pascal.slice(1); };
const collectionName = (name: string) => { const field = fieldName(name); return field.endsWith("s") ? field : `${field}s`; };
export const graphqlNames = { typeName, fieldName, collectionName };

export type NamingWarning = { typeId: string; name: string; graphqlName: string; reason: string };
const suffix = (id: string) => id.replace(/[^A-Za-z0-9]/g, "").slice(-8);

/** Hands out unique names in one scope; a taken name gets the type ID suffix. */
export function nameScope(reserved: Iterable<string>, warnings: NamingWarning[], scope: string) {
  const taken = new Set(reserved);
  return (wanted: string, owner: { id: string; name: string }) => {
    let name = wanted;
    if (taken.has(name)) {
      name = `${wanted}_${suffix(owner.id)}`;
      for (let n = 2; taken.has(name); n++) name = `${wanted}_${owner.id.replace(/[^A-Za-z0-9]/g, "")}${n > 2 ? n : ""}`;
      warnings.push({ typeId: owner.id, name: owner.name, graphqlName: name, reason: `${scope}: ${wanted} is already taken` });
    }
    taken.add(name);
    return name;
  };
}

const ontologyOf = (type: TypeRow) => (type.ontology ?? undefined) as Partial<OntologyV2> | undefined;
export const isInterval = (type: TypeRow) => ontologyOf(type)?.validity === "interval";
const graphqlName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const declaredProperties = (type: TypeRow) => (Array.isArray(type.properties) ? type.properties : []).filter((p): p is Property => typeof p?.name === "string");
/** Endpoint type lists, when both ends name types; a generic ("any") end gets no typed fields. */
export const endpointsOf = (type: TypeRow) => {
  const endpoints = ontologyOf(type)?.endpoints;
  return endpoints && Array.isArray(endpoints.from) && Array.isArray(endpoints.to) ? { from: endpoints.from, to: endpoints.to } : undefined;
};
export const slotsOf = (type: TypeRow): Slot[] => ontologyOf(type)?.stereotype === "relator" ? ontologyOf(type)?.participation?.slots ?? [] : [];

/** Shared names the generator itself defines. */
export const reservedTypeNames = ["Query", "Node", "Edge", "PageInfo", "Aggregate", "SearchConnection", "Archived", "Direction", "JSON", "DateTime", "String", "Int", "Float", "Boolean", "ID"];
export const reservedRootFields = ["node", "search", "searchConnection", "sdl"];
export const nodeBaseFields = ["id", "typeId", "revision", "title", "summary", "slug", "body", "archived", "updatedAt", "properties", "edges"];
export const edgeBaseFields = ["id", "typeId", "revision", "title", "body", "fromId", "toId", "from", "to", "properties", "archived", "updatedAt", "validFrom", "validUntil"];

export type Relationship = { field: string; edgeType: TypeRow; direction: "outgoing" | "incoming"; targets: string[]; edges: boolean;
  /** A derived edge type: reached through a relator, from one slot's participants to another's. */
  projection?: { relatorTypeId: string; via: Slot; to: Slot } };
export type SlotField = { field: string; slot: Slot; relator: TypeRow };
export type ReverseSlot = { field: string; relator: TypeRow; slots: Slot[] };
export type NodeLayout = { type: TypeRow; name: string; connection: string; single: string; collection: string;
  properties: { field: string; property: Property }[]; relationships: Relationship[]; slots: SlotField[]; reverse: ReverseSlot[] };
export type EdgeLayout = { type: TypeRow; name: string; properties: { field: string; property: Property }[] };
/** Names a caller adds to the schema, kept away from generated names. */
export type ReservedNames = { rootFieldNames?: string[]; typeNames?: string[]; recordFieldNames?: string[] };

type Scope = ReturnType<typeof nameScope>;
type Layout = { nodes: Map<string, NodeLayout>; edges: Map<string, EdgeLayout>; warnings: NamingWarning[]; scopes: Map<string, Scope> };
const scopeOf = (layout: Layout, typeId: string) => layout.scopes.get(typeId) as Scope;
const nodeOf = (layout: Layout, typeId: string) => layout.nodes.get(typeId) as NodeLayout;
const knownNodes = (layout: Layout, ids: string[]) => ids.filter(id => layout.nodes.has(id));
const createdAt = (type: TypeRow) => {
  const time = typeof type.createdAt === "number" ? type.createdAt : Date.parse(String(type.createdAt));
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
};
/** Older types keep the clean name, so adding a type never renames an existing one. */
const byAge = (a: TypeRow, b: TypeRow) => createdAt(a) - createdAt(b) || compareIds(a.id, b.id);

function addType(layout: Layout, type: TypeRow, typeScope: Scope, root: Scope, recordFields: string[]) {
  const name = typeScope(typeName(type.name), type);
  const props = (base: string[]) => {
    const scope = nameScope([...base, ...recordFields], layout.warnings, `field of ${name}`);
    layout.scopes.set(type.id, scope);
    return declaredProperties(type).flatMap(property => {
      if (graphqlName.test(property.name) && !property.name.startsWith("__")) return [{ field: scope(property.name, type), property }];
      layout.warnings.push({ typeId: type.id, name: type.name, graphqlName: "", reason: `field of ${name}: property ${property.name} is not a GraphQL name; read it from properties` });
      return [];
    });
  };
  if (type.category === "edge") { layout.edges.set(type.id, { type, name, properties: props(edgeBaseFields) }); return; }
  const connection = typeScope(`${name}Connection`, type);
  const collection = root(collectionName(type.name), type);
  const single = root(collection === fieldName(type.name) ? `${fieldName(type.name)}ById` : fieldName(type.name), type);
  layout.nodes.set(type.id, { type, name, connection, single, collection, properties: props([...nodeBaseFields, "validFrom", "validUntil"]),
    relationships: [], slots: [], reverse: [] });
}

/** Fields of a projection edge type: participants of one relator slot reach those of the other. */
function addProjection(layout: Layout, edgeType: TypeRow, projection: NonNullable<OntologyV2["projection"]>) {
  const relator = layout.nodes.get(projection.relatorTypeId);
  const slot = (name: string) => relator && slotsOf(relator.type).find(item => item.name === name);
  const from = slot(projection.fromSlot), to = slot(projection.toSlot);
  if (!from || !to) return;
  const sides = projection.symmetric || from === to ? [[from, to, ""] as const] : [[from, to, ""] as const, [to, from, "Incoming"] as const];
  for (const [via, toward, tail] of sides) for (const id of knownNodes(layout, via.participantTypes)) {
    nodeOf(layout, id).relationships.push({ field: scopeOf(layout, id)(`${fieldName(edgeType.name)}${tail}`, edgeType), edgeType, direction: tail ? "incoming" : "outgoing",
      targets: knownNodes(layout, toward.participantTypes), edges: false, projection: { relatorTypeId: projection.relatorTypeId, via, to: toward } });
  }
}

/** Typed relationship fields, only for edge types that declare endpoints (or project a relator).
 * A relator whose slot already covers the edge type keeps the slot and the …Edges field only. */
function addRelationships(layout: Layout, edgeType: TypeRow) {
  const endpoints = endpointsOf(edgeType);
  const projection = ontologyOf(edgeType)?.projection;
  if (projection) return addProjection(layout, edgeType, projection);
  if (!endpoints) return;
  const from = knownNodes(layout, endpoints.from), to = knownNodes(layout, endpoints.to);
  for (const [side, targets, direction, tail] of [[from, to, "outgoing", ""], [to, from, "incoming", "Incoming"]] as const) {
    for (const id of side) {
      const node = nodeOf(layout, id), scope = scopeOf(layout, id);
      const base = `${fieldName(edgeType.name)}${tail}`;
      if (!node.slots.some(({ slot }) => slot.edgeTypeId === edgeType.id))
        node.relationships.push({ field: scope(base, edgeType), edgeType, direction, targets: [...targets], edges: false });
      node.relationships.push({ field: scope(`${base}Edges`, edgeType), edgeType, direction, targets: [...targets], edges: true });
    }
  }
}

/** The reverse connection on each participant type of a relator. */
function addReverseSlots(layout: Layout, relator: NodeLayout) {
  const slots = slotsOf(relator.type);
  for (const participantId of new Set(slots.flatMap(slot => knownNodes(layout, slot.participantTypes)))) {
    nodeOf(layout, participantId).reverse.push({ field: scopeOf(layout, participantId)(collectionName(relator.type.name), relator.type), relator: relator.type,
      slots: slots.filter(slot => slot.participantTypes.includes(participantId)) });
  }
}

/** Every generated name, decided once, oldest type first (createdAt, then ID).
 * Within a type: base and caller fields, properties, slots, relationships, then reverse slot connections. */
export function schemaLayout(rows: TypeRow[], reserved: ReservedNames = {}) {
  const layout: Layout = { nodes: new Map(), edges: new Map(), warnings: [], scopes: new Map() };
  const typeScope = nameScope([...reservedTypeNames, ...reserved.typeNames ?? []], layout.warnings, "type name");
  const root = nameScope([...reservedRootFields, ...reserved.rootFieldNames ?? []], layout.warnings, "root field");
  const types = rows.filter(type => !type.archived && (type.category === "node" || type.category === "edge")).sort(byAge);
  for (const type of types) addType(layout, type, typeScope, root, reserved.recordFieldNames ?? []);
  for (const node of layout.nodes.values())
    for (const slot of slotsOf(node.type)) node.slots.push({ field: scopeOf(layout, node.type.id)(slot.name, node.type), slot, relator: node.type });
  for (const { type } of layout.edges.values()) addRelationships(layout, type);
  for (const node of layout.nodes.values()) addReverseSlots(layout, node);
  return { nodes: layout.nodes, edges: layout.edges, warnings: layout.warnings };
}
export type SchemaLayout = ReturnType<typeof schemaLayout>;
