// Onto's built-in advice on a draft batch: plain checks with no model, run on every
// staging call (the receipt's `advice`) and again in the steward's review. They look
// for records that need a type nobody named (docs/plans/missing-types.md), types that
// sprawl, and cards that say nothing. Advice never blocks: the agent stages the
// suggested fix, changes it, or keeps its records with a reason.
import { z } from "zod";
import { addressIndex, isUuid, resolveAddress } from "../lib/addresses";
import { core, type Graph, type TypeDefinition } from "../lib/graph";

/** Proposals an agent can stage as they are, and the staged refs that should move to them. */
export const stageFix = z.strictObject({
  proposals: z.array(z.record(z.string(), z.json())).max(20),
  move: z.array(z.string().max(80)).max(200),
});
export const finding = z.strictObject({
  /** The operation it is about, or null for the batch as a whole. */
  ref: z.string().max(80).nullable(),
  /** Every operation it covers, when more than one. */
  refs: z.array(z.string().max(80)).max(200).optional(),
  rule: z.string().min(1).max(64),
  severity: z.enum(["error", "warning", "note"]),
  message: z.string().min(1).max(1000),
  fix: z.string().max(1000).nullable(),
  stage: stageFix.optional(),
});
export type Finding = z.infer<typeof finding> & {
  /** Resolved by Onto against saved nodes in this Wiki. */
  organizationCandidates?: { id: string; title: string; slug?: string; match: string }[];
};

export type AdviceRow = {
  ref: string;
  operation: { operation: string; type: string; id?: string; attributes: Record<string, unknown> };
  evidence?: unknown;
  state: string;
};

/** A type an agent could propose: a node type with properties, or an edge type with endpoints by type name. */
export type SuggestedType = {
  category: "node" | "edge"; name: string; title: string; body: string;
  properties: { name: string; type: "string" | "number" | "boolean"; description: string }[];
  from: string[]; to: string[];
};

/** Catch-all types: fine for prose, a smell for look-alike records. */
const catchAll = new Set([core.document, core.entity]);
const catchAllNames = new Set(["Document", "Entity"]);
const minCluster = 3;
const edgeCluster = 5;
const boilerplateCards = 5;
const quoteLimit = 300;
/** More new node types than this in one batch is sprawl. */
const typeBudget = 4;
const refCap = 100;

const words = (text: string) => text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
const pascal = (text: string) => text.replace(/[^A-Za-z0-9]+/g, " ").trim().split(/\s+/).map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase()).join("").slice(0, 64);
const snake = (text: string) => text.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
const cap = (refs: string[]) => [...new Set(refs)].slice(0, refCap);
const quoted = (text: string) => `"${text.length > 80 ? `${text.slice(0, 79)}…` : text}"`;

/** A stable UUID for a suggested type, so the same draft suggests the same IDs on every call. */
export function suggestedTypeId(seed: string) {
  let hex = "";
  for (let round = 0; round < 4; round++) {
    let hash = 0x811c9dc5 ^ round;
    for (const char of `${round}:${seed}`) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
    hex += hash.toString(16).padStart(8, "0");
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// Title patterns. Each names the property it stands for.
const units: [RegExp, string, string][] = [
  [/^(ms|msec|milliseconds?)$/, "duration_ms", "Length in milliseconds"],
  [/^(s|sec|secs|seconds?)$/, "duration_seconds", "Length in seconds"],
  [/^(m|min|mins|minutes?)$/, "duration_minutes", "Length in minutes"],
  [/^(h|hr|hrs|hours?)$/, "duration_hours", "Length in hours"],
  [/^days?$/, "duration_days", "Length in days"],
  [/^weeks?$/, "duration_weeks", "Length in weeks"],
  [/^%$/, "percent", "Percentage"],
];
type Pattern = { key: string; property: string; description: string; label: string };
function unitProperty(unit: string): Pattern {
  const lower = unit.toLowerCase();
  const known = units.find(([pattern]) => pattern.test(lower));
  const property = known ? known[1] : `amount_${snake(lower) || "value"}`;
  return { key: `unit:${property}`, property, description: known ? known[2] : `Amount in ${unit}`, label: `a number in ${lower}` };
}
const sequence: Pattern = { key: "sequence", property: "sequence", description: "Position in its parent, from 1", label: "an order number" };
/** The number-plus-unit or ordinal a title carries, if any. */
export function titlePatterns(title: string): Pattern[] {
  const found: Pattern[] = [];
  const bracket = /\(\s*\d+(?:\.\d+)?\s*([a-zA-Z%]{1,8})\s*\)/.exec(title);
  const spelled = /\b\d+\s*-?\s*(seconds?|secs?|minutes?|mins?|hours?|days?|weeks?)\b/i.exec(title);
  if (bracket) found.push(unitProperty(bracket[1]));
  else if (spelled) found.push(unitProperty(spelled[1]));
  if (/^\s*#?\d{1,3}(?:\s*[.\-—–:)|]|\s+\S)/.test(title) || /\b(step|phase|part|stage|round|chapter|episode|scene|shot|act|wave|tier|level)\s+(\d{1,3}|[ivx]{1,5})\b/i.test(title) || /\b\d{1,3}(st|nd|rd|th)\b/i.test(title))
    found.push(sequence);
  return found;
}
/** The word every title ends with, and the word every title begins with, when they share one. */
function sharedWords(titles: string[]) {
  const split = titles.map((title) => words(title).split(" ").filter((word) => word && !/^\d+$/.test(word) && !/^\d+[a-z]{1,3}$/.test(word)));
  const shared = (pick: (list: string[]) => string | undefined) => {
    const word = pick(split[0] ?? []);
    return word && word.length >= 3 && split.every((list) => pick(list) === word) ? word : null;
  };
  return { last: shared((list) => list.at(-1)), first: shared((list) => list[0]) };
}

/** The batch's rows, with type and node references resolved the way the graph resolves them. */
function readRows(graph: Graph, rows: AdviceRow[]) {
  const live = rows.filter((row) => row.state !== "rejected" && row.state !== "removed");
  const index = addressIndex(graph);
  const typesById = new Map(graph.types.map((type) => [type.id, type]));
  const typesByName = new Map(graph.types.map((type) => [type.name, type]));
  const stagedTypes = new Map(live.filter((row) => row.operation.type === "graph-type" && row.operation.operation === "create").map((row) => [row.ref, row]));
  const stagedTypeByName = new Map([...stagedTypes.values()].map((row) => [String(row.operation.attributes.name), row]));
  /** A type reference: an existing type, a staged one, or unknown. */
  const typeOf = (value: unknown): { key: string; name: string; existing: TypeDefinition | null; staged: AdviceRow | null } => {
    const text = String(value ?? "");
    const staged = stagedTypes.get(text) ?? (isUuid(text) ? [...stagedTypes.values()].find((row) => row.operation.attributes.id === text.toLowerCase()) : stagedTypeByName.get(text));
    if (staged) return { key: staged.ref, name: String(staged.operation.attributes.name), existing: null, staged };
    const existing = (isUuid(text) ? typesById.get(text.toLowerCase()) : typesByName.get(text)) ?? null;
    return { key: existing?.id ?? text, name: existing?.name ?? text, existing, staged: null };
  };
  const created = live.filter((row) => row.operation.type === "graph-node" && row.operation.operation === "create");
  const createdById = new Map(created.flatMap((row) => typeof row.operation.attributes.id === "string" ? [[row.operation.attributes.id.toLowerCase(), row.ref]] : []));
  /** A node reference, as a staged ref or a saved node's ID. */
  const nodeOf = (value: unknown) => {
    const text = String(value ?? "");
    if (text.startsWith("$")) return text;
    let id = text;
    try { id = resolveAddress(index, "graph-node", text); } catch { /* left as written */ }
    return createdById.get(id) ?? id;
  };
  const nodeType = new Map<string, ReturnType<typeof typeOf>>();
  for (const node of graph.nodes) nodeType.set(node.id, typeOf(node.typeId));
  for (const row of created) nodeType.set(row.ref, typeOf(row.operation.attributes.typeId));
  const nodeTitle = new Map<string, string>(graph.nodes.map((node) => [node.id, node.title]));
  for (const row of created) nodeTitle.set(row.ref, String(row.operation.attributes.title ?? row.ref));
  const edges = live.filter((row) => row.operation.type === "graph-edge" && row.operation.operation === "create").map((row) => ({
    row, type: typeOf(row.operation.attributes.typeId), from: nodeOf(row.operation.attributes.fromId), to: nodeOf(row.operation.attributes.toId),
  }));
  const savedEdges = graph.edges.filter((edge) => !edge.archived).map((edge) => ({ type: typeOf(edge.typeId), from: createdById.get(edge.fromId) ?? edge.fromId, to: createdById.get(edge.toId) ?? edge.toId }));
  const isCatchAll = (type: ReturnType<typeof typeOf>) => type.existing ? catchAll.has(type.existing.id) : catchAllNames.has(type.name);
  return { live, created, edges, savedEdges, stagedTypes, typesByName, typeOf, nodeType, nodeTitle, isCatchAll };
}
type Read = ReturnType<typeof readRows>;

/** Turn suggested types into proposals the agent can stage as they are. */
export function stageTypes(graph: Graph, seed: string, rule: string, types: SuggestedType[], move: string[]): z.infer<typeof stageFix> {
  const byName = new Map(graph.types.map((type) => [type.name, type.id]));
  const ids = new Map(types.map((type) => [type.name, byName.get(type.name) ?? suggestedTypeId(`${seed}:${type.name}`)]));
  const endpoint = (names: string[]) => {
    const resolved = names.flatMap((name) => { const id = ids.get(name) ?? byName.get(name) ?? (isUuid(name) ? name : undefined); return id ? [id] : []; });
    return resolved.length ? [...new Set(resolved)] : "any";
  };
  const proposals = types.filter((type) => !byName.has(type.name) && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(type.name)).map((type) => ({
    operation: {
      operation: "create", type: "graph-type", ref: `$type-${snake(type.name).replace(/_/g, "-") || "new"}`.slice(0, 64),
      attributes: {
        id: ids.get(type.name)!, category: type.category, name: type.name, title: (type.title || type.name).slice(0, 120), body: (type.body || type.title || type.name).slice(0, 2000),
        properties: type.properties.filter((property) => /^[a-z][a-z0-9_]{0,47}$/.test(property.name)).slice(0, 32).map((property) => ({ ...property, required: false })),
        ...(type.category === "edge" ? { ontology: { version: 1, endpoints: { from: endpoint(type.from), to: endpoint(type.to) } } } : {}),
      },
    },
    evidence: [], confidence: 0.6, reason: `Suggested by Onto (${rule}): the moved records share this shape.`,
  }));
  return { proposals, move: cap(move) };
}

/** `type.generic-cluster` and the edge type it implies, with a stageable fix. */
function genericClusters(graph: Graph, read: Read, seed: string): Finding[] {
  const findings: Finding[] = [];
  const covered = new Set<string>();
  const generic = read.created.filter((row) => read.isCatchAll(read.nodeType.get(row.ref)!));
  const genericRefs = new Set(generic.map((row) => row.ref));
  const title = (ref: string) => read.nodeTitle.get(ref) ?? ref;
  const suggest = (refs: string[], parent: { edge: string; type: string; title: string } | null, catchAllName: string, reason: string) => {
    const titles = refs.map(title);
    const patterns = new Map<string, Pattern>();
    for (const pattern of titles.flatMap(titlePatterns)) patterns.set(pattern.key, pattern);
    const shared = sharedWords(titles);
    // A common last word can name an existing type ("... brief" → Brief); a first word only suggests a name.
    const existing = shared.last ? graph.types.find((type) => type.category === "node" && type.name.toLowerCase() === shared.last && !catchAll.has(type.id)) : undefined;
    let name = existing?.name ?? pascal(shared.last ?? shared.first ?? (patterns.has("sequence") ? "step" : parent ? `${parent.title} item` : "item"));
    if (!existing && graph.types.some((type) => type.name === name)) name = `${name}Entry`;
    const properties = [...patterns.values()].map((pattern) => ({ name: pattern.property, type: "number" as const, description: pattern.description }));
    const types: SuggestedType[] = existing ? [] : [{ category: "node", name, title: name.replace(/([a-z])([A-Z])/g, "$1 $2"), properties, from: [], to: [],
      body: `One ${name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()}. Suggested by Onto for ${refs.length} records staged as ${catchAllName} that ${reason}; say here what belongs in it.` }];
    const edgeName = parent ? `${snake(name)}_of` : null;
    if (parent && edgeName && !graph.types.some((type) => type.name === edgeName))
      types.push({ category: "edge", name: edgeName, title: `${name} of`, body: `A ${name} belongs to its ${parent.type}.`, properties: [], from: [name], to: [parent.type] });
    const stage = stageTypes(graph, seed, "type.generic-cluster", types, refs);
    const what = [...patterns.values()].map((pattern) => pattern.label);
    const fix = existing
      ? `Stage them as ${existing.name} instead of ${catchAllName}${what.length ? `, with ${what.join(" and ")} as properties` : ""}.`
      : `Stage the type${edgeName ? ` ${name} and the relationship ${edgeName} (${name} → ${parent!.type})` : ` ${name}`}${properties.length ? ` with ${properties.map((property) => property.name).join(", ")} as properties` : ""}, then restage these records under it (create new, remove the ${catchAllName} ones). Rename it for what they are, or keep them with a reason.`;
    return { stage, fix, name: existing?.name ?? name };
  };
  // Records that share a parent through the same relationship.
  const siblings = new Map<string, { refs: string[]; edge: string; parent: string }>();
  for (const edge of [...read.edges, ...read.savedEdges]) {
    if (!genericRefs.has(edge.from)) continue;
    const key = `${edge.type.key}|${edge.to}|${read.nodeType.get(edge.from)!.name}`;
    const group = siblings.get(key) ?? { refs: [], edge: edge.type.name, parent: edge.to };
    if (!group.refs.includes(edge.from)) group.refs.push(edge.from);
    siblings.set(key, group);
  }
  for (const group of siblings.values()) {
    if (group.refs.length < minCluster) continue;
    const catchAllName = read.nodeType.get(group.refs[0])!.name;
    const parentType = read.nodeType.get(group.parent)?.name ?? "record";
    const parentTitle = read.nodeTitle.get(group.parent) ?? group.parent;
    const { stage, fix, name } = suggest(group.refs, { edge: group.edge, type: parentType, title: parentTitle }, catchAllName, `are ${group.edge} the same ${parentType}`);
    findings.push({ ref: null, refs: cap(group.refs), rule: "type.generic-cluster", severity: "warning",
      message: `${group.refs.length} new ${catchAllName} records are ${group.edge} ${quoted(parentTitle)} (${quoted(title(group.refs[0]))} and others). Records that share a shape need a type someone can query by, such as ${name}.`,
      fix, stage });
    for (const ref of group.refs) covered.add(ref);
  }
  // Records whose titles share a pattern: leading numbers, a unit in brackets, a common last word.
  const byPattern = new Map<string, { refs: string[]; label: string }>();
  for (const row of generic) {
    const text = title(row.ref);
    const keys = titlePatterns(text).map((pattern) => [pattern.key, pattern.label] as const);
    const last = words(text).split(" ").filter((word) => !/^\d/.test(word)).at(-1);
    if (last && last.length >= 3 && !catchAllNames.has(pascal(last))) keys.push([`word:${last}`, `the word "${last}"`] as const);
    for (const [key, label] of keys) {
      const group = byPattern.get(key) ?? { refs: [], label };
      group.refs.push(row.ref);
      byPattern.set(key, group);
    }
  }
  for (const group of [...byPattern.values()].sort((a, b) => b.refs.length - a.refs.length)) {
    const refs = group.refs.filter((ref) => !covered.has(ref));
    if (refs.length < minCluster) continue;
    const catchAllName = read.nodeType.get(refs[0])!.name;
    const { stage, fix, name } = suggest(refs, null, catchAllName, `share ${group.label} in their titles`);
    findings.push({ ref: null, refs: cap(refs), rule: "type.generic-cluster", severity: "warning",
      message: `${refs.length} new ${catchAllName} records share ${group.label} in their titles (${quoted(title(refs[0]))} and others). The shape is hiding in the titles; give them a type such as ${name}.`,
      fix, stage });
    for (const ref of refs) covered.add(ref);
  }
  // One relationship used many times between catch-all records.
  const pairs = new Map<string, { refs: string[]; edge: string; from: string; to: string }>();
  for (const edge of read.edges) {
    const from = read.nodeType.get(edge.from), to = read.nodeType.get(edge.to);
    if (!from || !to || !read.isCatchAll(from) || !read.isCatchAll(to)) continue;
    const key = `${edge.type.key}|${from.name}|${to.name}`;
    const group = pairs.get(key) ?? { refs: [], edge: edge.type.name, from: from.name, to: to.name };
    group.refs.push(edge.row.ref);
    pairs.set(key, group);
  }
  for (const group of pairs.values()) {
    if (group.refs.length < edgeCluster) continue;
    findings.push({ ref: null, refs: cap(group.refs), rule: "edge.generic-cluster", severity: "warning",
      message: `${group.edge} links ${group.from} → ${group.to} ${group.refs.length} times in this batch. Nothing can ask for these by meaning; the structure lives only in titles.`,
      fix: `Give the records specific types (see type.generic-cluster) and name each relationship for what it means, with endpoints, such as shot_of (Shot → Storyboard).` });
  }
  return findings;
}

/** `property.in-title`: a number-plus-unit or ordinal repeated across sibling titles. */
function propertiesInTitles(read: Read, clustered: Set<string>): Finding[] {
  const findings: Finding[] = [];
  const groups = new Map<string, { type: ReturnType<Read["typeOf"]>; pattern: Pattern; refs: string[] }>();
  for (const row of read.created) {
    if (clustered.has(row.ref)) continue;
    const type = read.nodeType.get(row.ref)!;
    for (const pattern of titlePatterns(read.nodeTitle.get(row.ref) ?? "")) {
      const key = `${type.key}|${pattern.key}`;
      const group = groups.get(key) ?? { type, pattern, refs: [] };
      group.refs.push(row.ref);
      groups.set(key, group);
    }
  }
  for (const { type, pattern, refs } of groups.values()) {
    if (refs.length < minCluster) continue;
    const has = type.existing?.properties.some((property) => property.name === pattern.property) ?? false;
    const example = read.nodeTitle.get(refs[0]) ?? refs[0];
    const stage = type.existing && !has && !catchAll.has(type.existing.id) ? {
      proposals: [{ operation: { operation: "update", type: "graph-type", ref: `$${snake(type.name).replace(/_/g, "-")}-${pattern.property.replace(/_/g, "-")}`.slice(0, 64), id: type.name, revision: type.existing.revision,
        attributes: { properties: [...type.existing.properties, { name: pattern.property, type: "number", description: pattern.description, required: false }] } },
        evidence: [], confidence: 0.6, reason: `Suggested by Onto (property.in-title): ${refs.length} ${type.name} titles carry it.` }],
      move: cap(refs),
    } : undefined;
    findings.push({ ref: null, refs: cap(refs), rule: "property.in-title", severity: "warning",
      message: `${refs.length} new ${type.name} titles carry ${pattern.label} (${quoted(example)} and others). Nothing can sort or filter by it while it is title text.`,
      fix: `${has ? `Set the ${pattern.property} property` : `Add a ${pattern.property} property to ${type.name}${type.staged ? ` (${type.staged.ref})` : ""}`} and drop it from the titles.`,
      ...(stage ? { stage } : {}) });
  }
  return findings;
}

/** `type.sprawl`: too many new types, types with too few records, or a type that repeats an existing one. */
function sprawl(graph: Graph, read: Read): Finding[] {
  const findings: Finding[] = [];
  const nodeTypes = [...read.stagedTypes.values()].filter((row) => row.operation.attributes.category === "node");
  if (nodeTypes.length > typeBudget)
    findings.push({ ref: null, refs: cap(nodeTypes.map((row) => row.ref)), rule: "type.sprawl", severity: "warning",
      message: `This batch creates ${nodeTypes.length} node types. A type is for records several of which share a shape someone will query by.`,
      fix: "Keep the types records will be queried by; fold near-identical ones into one type with a property (such as kind)." });
  for (const row of read.stagedTypes.values()) {
    const attributes = row.operation.attributes;
    const name = String(attributes.name);
    const category = attributes.category;
    const props = new Set((Array.isArray(attributes.properties) ? attributes.properties : []).map((property: { name?: unknown }) => String(property?.name)));
    const endpoints = (attributes.ontology as { endpoints?: { from?: unknown; to?: unknown } } | undefined)?.endpoints;
    const side = (value: unknown) => Array.isArray(value) ? [...value].map(String).sort().join(",") : String(value ?? "any");
    const same = graph.types.find((type) => {
      if (type.archived || type.category !== category) return false;
      const theirs = new Set(type.properties.map((property) => property.name));
      const sameProps = props.size >= 2 && theirs.size === props.size && [...props].every((prop) => theirs.has(prop));
      if (category === "node") return sameProps;
      if (type.name.toLowerCase() !== name.toLowerCase()) return false;
      const their = type.ontology?.endpoints;
      return !!endpoints && !!their && Array.isArray(endpoints.from) && Array.isArray(endpoints.to) && side(endpoints.from) === side(their.from) && side(endpoints.to) === side(their.to) && (props.size === 0 || sameProps);
    });
    const records = category === "node" ? read.created.filter((node) => read.nodeType.get(node.ref)?.key === row.ref).map((node) => node.ref)
      : read.edges.filter((edge) => edge.type.key === row.ref).map((edge) => edge.row.ref);
    if (same)
      findings.push({ ref: row.ref, refs: cap([row.ref, ...records]), rule: "type.sprawl", severity: "warning",
        message: `New ${category} type ${name} has the same ${category === "node" ? "properties" : "endpoints"} as ${same.name} (${same.id}).`,
        fix: `Use ${same.name} instead of ${name}${records.length ? ` for its ${records.length} records` : ""}, and remove ${row.ref}.`,
        stage: { proposals: [], move: cap(records) } });
    else if (category === "node" && records.length < minCluster)
      findings.push({ ref: row.ref, rule: "type.sprawl", severity: "note",
        message: `New type ${name} has ${records.length === 0 ? "no records" : `only ${records.length} ${records.length === 1 ? "record" : "records"}`} in this batch.`,
        fix: "Propose a type when several records share its shape; otherwise use an existing type, with a property if it needs one." });
  }
  return findings;
}

/** Card quality: summaries that repeat, boilerplate bodies and evidence that quotes too much. */
function cards(read: Read): Finding[] {
  const repeatsTitle: string[] = [], repeatsBody: string[] = [], longQuotes: string[] = [];
  const paragraphs = new Map<string, { text: string; refs: Set<string> }>();
  for (const row of read.live) {
    const attributes = row.operation.attributes;
    if (row.operation.type === "graph-node") {
      const title = words(String(attributes.title ?? "")), summary = words(String(attributes.summary ?? "")), body = String(attributes.body ?? "");
      if (summary && title && (summary === title || summary.split(" ").every((word) => title.split(" ").includes(word)))) repeatsTitle.push(row.ref);
      else if (summary.length >= 20 && words(body).includes(summary)) repeatsBody.push(row.ref);
      for (const paragraph of body.split(/\n\s*\n/)) {
        const text = paragraph.trim();
        const key = words(text);
        if (text.startsWith("#") || key.length < 60) continue;
        const entry = paragraphs.get(key) ?? { text, refs: new Set<string>() };
        entry.refs.add(row.ref);
        paragraphs.set(key, entry);
      }
    }
    const evidence = Array.isArray(row.evidence) ? row.evidence as { quote?: unknown }[] : [];
    if (evidence.some((item) => typeof item?.quote === "string" && item.quote.length > quoteLimit)) longQuotes.push(row.ref);
  }
  const findings: Finding[] = [];
  const grouped = (refs: string[], rule: string, message: string, fix: string) => {
    if (refs.length) findings.push({ ref: refs.length === 1 ? refs[0] : null, ...(refs.length > 1 ? { refs: cap(refs) } : {}), rule, severity: "note", message: `${refs.length === 1 ? "One card" : `${refs.length} cards`} ${message}`, fix });
  };
  grouped(repeatsTitle, "card.summary-repeats-title", "only repeat the title in the summary.", "Say in the summary what it is and why this organization cares.");
  grouped(repeatsBody, "card.summary-repeats-body", "repeat the summary in the body.", "Keep the body for what the summary does not say; leave it empty otherwise.");
  for (const { text, refs } of [...paragraphs.values()].filter((entry) => entry.refs.size > boilerplateCards).slice(0, 3))
    findings.push({ ref: null, refs: cap([...refs]), rule: "card.boilerplate", severity: "note",
      message: `The same paragraph is on ${refs.size} cards: ${quoted(text)}`, fix: "Say it once in the batch purpose and drop it from the cards." });
  grouped(longQuotes, "evidence.quote-too-long", `quote more than ${quoteLimit} characters of evidence.`, "Quote the sentence that supports the claim; the citation points to the rest.");
  return findings;
}

/** Every advice finding for a draft. `seed` keeps suggested type IDs stable for one batch. */
export function batchAdvice(graph: Graph, rows: AdviceRow[], seed: string): Finding[] {
  const read = readRows(graph, rows);
  const clusters = genericClusters(graph, read, seed);
  const clustered = new Set(clusters.flatMap((item) => item.rule === "type.generic-cluster" ? item.refs ?? [] : []));
  return [...clusters, ...propertiesInTitles(read, clustered), ...sprawl(graph, read), ...cards(read)];
}

const typeRules = new Set(["type.generic-cluster", "edge.generic-cluster", "property.in-title", "type.sprawl"]);
/** The receipt's instruction for advice: optional, and only when there is advice about types. */
export function adviceInstructions(itemKey: string, advice: Finding[]) {
  const types = advice.filter((item) => typeRules.has(item.rule));
  if (!types.length) return [];
  const rules = [...new Set(types.map((item) => item.rule))].join(", ");
  return [{ code: "CONSIDER_TYPES", itemKey, actor: "caller" as const, required: false,
    message: `Onto has advice on this draft (${rules}). Read advice: stage a finding's stage.proposals and restage the refs in stage.move under it, or keep the records with a reason.` }];
}
