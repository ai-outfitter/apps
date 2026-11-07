import { agentPage } from "@ai-outfitter/app-sdk/agent-context";
import {
  createKnowledgeGraphViewer,
} from "@ai-outfitter/ui/knowledge-graph";
import { core, type Graph, type GraphNode } from "../lib/graph";
import { definitionQuery, type GraphQuery, hasSelection, type GraphQueryRule, graphQueryParams, patternQuery, queryDefinition } from "../lib/knowledge-graph-query";
import {
  contextDefinition,
  definitionPattern,
  exploreKnowledgeGraph,
  knowledgeGraphDefinitionSchema,
  knowledgeGraphInstances,
  type KnowledgeGraphLens,
  knowledgeGraphsFor,
  loadKnowledgeGraph,
  type ResolvedGraphPattern,
  resolveKnowledgeGraph,
} from "../lib/knowledge-graphs";
import { call, el, entityUrl, link, notice, typeName } from "./data";

const savedQuery = (graph: Graph, definition: ResolvedGraphPattern, graphId?: string) => patternQuery(definition, (id) => typeName(graph, id), graphId);

function append(parent: Node, ...children: Node[]) {
  for (const child of children) parent.appendChild(child);
}
function lensView(graph: Graph, anchor: GraphNode, lens: KnowledgeGraphLens) {
  const description = lens.node.summary || lens.node.body;
  const section = el(
    "div",
    { class: "wiki-map knowledge-graph-detail" },
    // The selected chip already shows the title, so the heading is for screen readers only.
    el("h2", { class: "visually-hidden" }, lens.node.title),
    el("p", { class: "knowledge-graph-description", title: description }, description),
  );
  if (!lens.definition) {
    append(
      section,
      el(
        "p",
        { role: "alert" },
        `This knowledge graph cannot be displayed: ${lens.error}`,
      ),
    );
    return section;
  }
  append(section, ...graphView(graph, anchor, lens.definition));
  return section;
}
const graphUrl = (anchor: GraphNode, id: string) => `${entityUrl(anchor.id)}/knowledge-graphs/${encodeURIComponent(id)}`;
/** Disables `button` while `work` runs, and re-enables it with a notice when `work` fails. */
async function submitting(button: HTMLButtonElement, work: () => Promise<void>) {
  button.disabled = true;
  try {
    await work();
  } catch (error) {
    notice(error instanceof Error ? error.message : String(error));
    button.disabled = false;
  }
}
const queryUrl = (anchor: GraphNode, query: GraphQuery) =>
  `${entityUrl(anchor.id)}/knowledge-graphs?${graphQueryParams(query)}`;
function graphView(graph: Graph, anchor: GraphNode, definition: ResolvedGraphPattern) {
  const notes: Node[] = [];
  if (definition.missingTypes.length) notes.push(el("p", { role: "status" },
    `Context gaps: this Wiki does not define ${definition.missingTypes.join(", ")}.`));
  const view = exploreKnowledgeGraph(graph, anchor, definition);
  const rows = view.edges.map((edge) =>
    el(
      "li",
      {},
      link(
        view.nodes.find((n) => n.id === edge.fromId)?.title ?? "Entity",
        edge.fromId,
      ),
      " → ",
      typeName(graph, edge.typeId, "related"),
      edge.properties.path ? `: ${edge.properties.path}` : "",
      " → ",
      link(
        view.nodes.find((n) => n.id === edge.toId)?.title ?? "Entity",
        edge.toId,
      ),
    ),
  );
  return [
    ...notes,
    createKnowledgeGraphViewer(graph, view, anchor, {
      nodeHref: entityUrl,
      onError: (error) =>
        notice(error instanceof Error ? error.message : String(error)),
    }),
    ...(view.truncated
      ? [el("p", {}, `Showing the first ${definition.maxNodes} connected records.`)]
      : []),
    el(
      "details",
      {},
      el("summary", {}, `${rows.length} recorded relationships`),
      el("ul", { class: "graph-relations" }, ...rows),
    ),
  ];
}
/** Relationship types that touch this entity, so a member or agent knows where a query can start. */
function nearbyRelationships(graph: Graph, anchor: GraphNode) {
  const found = new Map<string, number>();
  for (const edge of graph.edges) {
    if (edge.archived) continue;
    const direction = edge.fromId === anchor.id ? "outgoing" : edge.toId === anchor.id ? "incoming" : null;
    if (!direction) continue;
    const key = direction === "incoming" ? `${typeName(graph, edge.typeId)}:incoming` : typeName(graph, edge.typeId);
    found.set(key, (found.get(key) ?? 0) + 1);
  }
  return [...found].map(([rel, count]) => ({ rel, count }));
}
const ruleLabel = (rule: GraphQueryRule) =>
  `${rule.type}${rule.direction === "incoming" ? " (incoming)" : ""}${rule.from_type || rule.to_type ? `, ${rule.from_type ?? "any"} → ${rule.to_type ?? "any"}` : ""}`;
const activeNames = (graph: Graph, category: "node" | "edge") =>
  graph.types.filter((type) => type.category === category && !type.archived).map((type) => type.name).sort((a, b) => a.localeCompare(b));
const options = (names: string[], first?: string) => [
  ...(first === undefined ? [] : [el("option", { value: "" }, first)]),
  ...names.map((value) => el("option", { value }, value)),
];
/**
 * Controls that reshape the draft. Each change opens the address for the new
 * query, so the member and the sidebar agent always edit the same draft.
 */
function queryControls(graph: Graph, anchor: GraphNode, query: GraphQuery) {
  const go = (next: Partial<GraphQuery>) => { location.href = queryUrl(anchor, { ...query, ...next }); };
  const chip = (label: string, title: string, onclick: () => void) =>
    el("span", { class: "knowledge-graph-chip" }, label,
      el("button", { type: "button", title, "aria-label": title, onclick }, "×"));
  // A draft needs one step, so the last one cannot be removed.
  const steps = query.relationships.map((rule, index) => query.relationships.length === 1
    ? el("span", { class: "knowledge-graph-chip" }, ruleLabel(rule))
    : chip(ruleLabel(rule), `Remove ${ruleLabel(rule)}`, () =>
      go({ relationships: query.relationships.filter((_, at) => at !== index) })));
  const nearby = nearbyRelationships(graph, anchor).map(({ rel }) => rel.split(":")[0]);
  const edgeNames = [...new Set([...nearby, ...activeNames(graph, "edge")])];
  const nodeNames = activeNames(graph, "node");
  const type = el("select", { name: "type", "aria-label": "Relationship" }, ...options(edgeNames));
  const direction = el("select", { name: "direction", "aria-label": "Direction" },
    el("option", { value: "outgoing" }, "outgoing"), el("option", { value: "incoming" }, "incoming"));
  const from = el("select", { name: "from", "aria-label": "From type" }, ...options(nodeNames, "from any"));
  const to = el("select", { name: "to", "aria-label": "To type" }, ...options(nodeNames, "to any"));
  const addStep = el("details", { class: "knowledge-graph-add" }, el("summary", {}, "Add step"),
    el("form", {
      onsubmit: (event: SubmitEvent) => {
        event.preventDefault();
        const rule: GraphQueryRule = { type: type.value, direction: direction.value as GraphQueryRule["direction"],
          ...(from.value ? { from_type: from.value } : {}), ...(to.value ? { to_type: to.value } : {}) };
        go({ relationships: [...query.relationships, rule].slice(0, 32) });
      },
    }, type, direction, from, to, el("button", { type: "submit" }, "Add")));
  // Stop at: shown, not expanded. Stop after: expands one more step, then stops.
  const stopControls = (key: "stopAtTypes" | "stopAfterTypes", label: string, prompt: string) => {
    const chosen = query[key];
    const picker = el("select", { "aria-label": `${label} type`, onchange: () => picker.value && go({ [key]: [...chosen, picker.value] }) },
      ...options(nodeNames.filter((name) => !chosen.includes(name)), prompt));
    return [...chosen.map((name) => chip(`${label.toLowerCase()} ${name}`, `Remove ${label.toLowerCase()} ${name}`, () => go({ [key]: chosen.filter((value) => value !== name) }))), picker];
  };
  const stops = [...stopControls("stopAtTypes", "Stop at", "Stop at…"), ...stopControls("stopAfterTypes", "Stop after", "Stop after…")];
  const number = (label: string, value: number, max: number, key: "maxDepth" | "maxNodes") =>
    el("label", {}, label, el("input", { type: "number", min: 1, max, value, onchange: (event: Event) => {
      const next = Number((event.target as HTMLInputElement).value);
      if (Number.isInteger(next) && next >= 1) go({ [key]: Math.min(next, max) });
    } }));
  return el("div", { class: "knowledge-graph-controls", role: "group", "aria-label": "Shape this graph" },
    ...steps, addStep, ...stops, number("Depth ", query.maxDepth, 10, "maxDepth"), number("Max ", query.maxNodes, 200, "maxNodes"));
}
/** A saved graph's JSON definition, the only kind Update may rewrite: older graphs keep prose in the body and their pattern in properties. */
function storedDefinition(node: GraphNode) {
  try {
    const definition = contextDefinition(node);
    return hasSelection(definition) ? definition : undefined;
  } catch {
    return undefined;
  }
}
/**
 * The draft query that adjusts a saved graph. A JSON definition is copied as
 * stored, so steps whose types this Wiki lacks survive an update.
 */
function adjustQuery(graph: Graph, lens: KnowledgeGraphLens) {
  const stored = storedDefinition(lens.node);
  if (stored) return definitionQuery(stored, lens.node.id);
  return lens.definition && savedQuery(graph, lens.definition, lens.node.id);
}
/** A graph shaped by URL params; a member who can edit saves it as a knowledge graph, or updates the one being adjusted. */
function queryView(graph: Graph, anchor: GraphNode, query: GraphQuery, adjusting?: KnowledgeGraphLens) {
  const rootType = typeName(graph, anchor.typeId);
  const stored = adjusting && storedDefinition(adjusting.node);
  const controls = queryControls(graph, anchor, query);
  const section = el("div", { class: "wiki-map knowledge-graph-detail" },
    el("h2", { class: "visually-hidden" }, adjusting ? `Adjust ${adjusting.node.title}` : "Draft knowledge graph"),
    controls);
  const draft = queryDefinition(query, { rootTypes: [rootType], name: anchor.title, purpose: "Draft" });
  let definition: ResolvedGraphPattern;
  try {
    definition = resolveKnowledgeGraph(graph, definitionPattern(draft));
  } catch (error) {
    append(section, el("p", { role: "alert" }, `This query cannot be displayed: ${error instanceof Error ? error.message : String(error)}`));
    return section;
  }
  if (graph.canEdit) {
    // Save actions share the controls row, so the graph keeps the room.
    const actions = el("div", { class: "knowledge-graph-actions" });
    if (adjusting && stored) {
      const update = el("button", { type: "button", onclick: () => submitting(update, async () => {
        const next = knowledgeGraphDefinitionSchema.parse(queryDefinition(query, stored));
        await call("graph/update", {
          type: "graph-node", id: adjusting.node.id, revision: adjusting.node.revision,
          attributes: { body: JSON.stringify(next, null, 2) },
          references: adjusting.node.source ? [adjusting.node.source] : [],
        });
        location.href = graphUrl(anchor, adjusting.node.id);
      }) }, `Update ${adjusting.node.title}`);
      append(actions, update);
    }
    const title = el("input", { name: "title", required: true, maxLength: 120, value: adjusting ? `${adjusting.node.title} (copy)` : `${anchor.title} graph` });
    const purpose = el("input", { name: "purpose", required: true, maxLength: 280, placeholder: "Why this graph exists" });
    const save = el("button", { type: "submit" }, "Save");
    // A retry after the attach step failed reuses the graph already created.
    let createdId: string | undefined;
    append(actions, el("details", { class: "knowledge-graph-add" }, el("summary", {}, adjusting ? "Save as new" : "Save as knowledge graph"), el("form", {
      class: "graph-fields",
      onsubmit: (event: SubmitEvent) => {
        event.preventDefault();
        void submitting(save, async () => {
          const identity = { rootTypes: stored?.rootTypes ?? [rootType], name: title.value.trim(), purpose: purpose.value.trim() };
          createdId ??= (await call<{ ref: { id: string } }>("graph/create", {
            type: "graph-node",
            attributes: { typeId: core.knowledgeGraph, title: identity.name, summary: identity.purpose, body: JSON.stringify(knowledgeGraphDefinitionSchema.parse(queryDefinition(query, identity)), null, 2) },
          })).ref.id;
          await call("graph/create", { type: "graph-edge", attributes: { typeId: core.lensFor, fromId: createdId, toId: anchor.id } });
          location.href = graphUrl(anchor, createdId);
        });
      },
    }, el("p", {}, `Saved knowledge graphs apply to every ${(stored?.rootTypes ?? [rootType]).join(", ")} and are attached to ${anchor.title}.`),
      el("label", {}, "Name ", title), el("label", {}, "Purpose ", purpose), save)));
    append(controls, actions);
  }
  append(section, ...graphView(graph, anchor, definition));
  return section;
}
function describeGraphs(graph: Graph, anchor: GraphNode, lenses: KnowledgeGraphLens[], selected?: KnowledgeGraphLens, query?: GraphQuery | null) {
  const adjust = selected && adjustQuery(graph, selected);
  const saved = adjust && graphQueryParams(adjust).toString();
  agentPage("wiki-map").describe({
    title: selected ? `${selected.node.title} for ${anchor.title}` : query ? `Draft knowledge graph for ${anchor.title}` : `Knowledge graphs for ${anchor.title}`,
    summary: query
      ? `A draft graph built from the address's rel, stop, depth and max params${query.graphId ? ", adjusting a saved graph the member can update" : ""}. Navigate with other params to reshape it; the member can save it.`
      : "Knowledge graphs for this entity. Open one, or build a draft with rel, stop, depth and max params on this page's address. To adjust a saved graph, start from its `selectedGraph.query`.",
    state: {
      entity: { id: anchor.id, title: anchor.title, type: typeName(graph, anchor.typeId) },
      graphs: lenses.map(({ node }) => ({ id: node.id, title: node.title })),
      ...(selected && saved ? { selectedGraph: { id: selected.node.id, query: saved } } : {}),
      ...(query ? { query: graphQueryParams(query).toString() } : {}),
      relationshipsHere: nearbyRelationships(graph, anchor).slice(0, 40),
    },
  });
}
export function knowledgeGraphViews(graph: Graph, anchor: GraphNode, selectedId?: string, query?: GraphQuery | null) {
  const lenses = knowledgeGraphsFor(graph, anchor);
  const section = el("div", { class: "wiki-map knowledge-graph-page" });
  const selected = lenses.find(({ node }) => node.id === selectedId);
  describeGraphs(graph, anchor, lenses, selected, query);
  append(section, el("h2", { class: "visually-hidden" }, "Knowledge graphs"));
  if (query && !selectedId) {
    if (lenses.length) append(section, el("nav", { class: "knowledge-graph-picker", "aria-label": "Knowledge graphs" },
      ...lenses.map(({ node }) => el("a", { href: graphUrl(anchor, node.id) }, node.title))));
    append(section, queryView(graph, anchor, query, lenses.find(({ node }) => node.id === query.graphId)));
    return section;
  }
  // A definition is not explored from itself: its graphs are its instances.
  if (anchor.typeId === core.knowledgeGraph && !lenses.length && !selectedId) {
    append(section, knowledgeGraphInstanceList(graph, anchor));
    return section;
  }
  if (!lenses.length && !selectedId) {
    append(section, el("p", {}, "No knowledge graph has been defined for this entity yet. Ask Onto to build one, or add rel params to this page's address."));
    return section;
  }
  const picker = el("nav", { class: "knowledge-graph-picker", "aria-label": "Knowledge graphs" },
    ...lenses.map(({ node }) => el("a", {
      href: graphUrl(anchor, node.id),
      ...(node.id === selectedId ? { "aria-current": "page" } : {}),
    }, node.title)),
  );
  if (!selected) {
    append(section, picker, selectedId
      ? el("p", { role: "alert" }, "This knowledge graph is not available for this entity.")
      : el("p", {}, "Choose a knowledge graph to explore this entity."));
    return section;
  }
  const adjust = adjustQuery(graph, selected);
  // Graph picker and graph links share one row to leave room for the graph.
  append(section,
    el("div", { class: "knowledge-graph-bar" }, picker,
      el("div", { class: "knowledge-graph-actions" },
        ...(selected.definition && adjust ? [el("a", { href: queryUrl(anchor, adjust) }, "Adjust this graph")] : []),
        link("Open graph definition", selected.node.id))),
    lensView(graph, anchor, selected));
  return section;
}

function knowledgeGraphDefinition(graph: Graph, node: GraphNode) {
  try {
    const definition = loadKnowledgeGraph(graph, node);
    return el(
      "section",
      { class: "graph-section" },
      el("h2", {}, "Traversal"),
      el(
        "p",
        {},
        "This lens starts from ",
        definition.rootTypes.map(id => graph.types.find(t => t.id === id)?.title ?? id).join(", "),
        `, following up to ${definition.maxDepth} relationships from the starting node.`,
      ),
      el(
        "ul",
        {},
        ...savedQuery(graph, definition).relationships.map((rule) => el("li", {}, ruleLabel(rule))),
      ),
      ...(definition.stopAtTypes.length
        ? [el("p", {}, `Stops at ${definition.stopAtTypes.map((id) => typeName(graph, id)).join(", ")}: shown, not expanded.`)]
        : []),
      ...(definition.stopAfterTypes.length
        ? [el("p", {}, `Stops after ${definition.stopAfterTypes.map((id) => typeName(graph, id)).join(", ")}: one more step is shown, then the walk stops.`)]
        : []),
    );
  } catch (error) {
    return el(
      "p",
      { role: "alert" },
      `This knowledge graph needs a valid traversal definition: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Instances of a knowledge graph, or why it has none to explore. */
function instancesOf(graph: Graph, node: GraphNode) {
  try {
    return { instances: knowledgeGraphInstances(graph, node) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
/** "ProductRevision" reads as "Product revision": type titles are plural, and one record is one of a kind. */
const typeTitle = (graph: Graph, id: string) => typeName(graph, id).replace(/([a-z])([A-Z])/g, (_, a: string, b: string) => `${a} ${b.toLowerCase()}`);
const instanceLink = (graph: Graph, node: GraphNode, root: GraphNode) =>
  el("a", { href: graphUrl(root, node.id), title: typeTitle(graph, root.typeId) }, root.title);
const firstInstances = 5;
/** Knowledge graph → the records it can be explored from; the instances are what a member opens. */
export function knowledgeGraphTable(graph: Graph, definitions: GraphNode[]) {
  const rows = definitions.map(node => ({ node, ...instancesOf(graph, node) }))
    .sort((a, b) => Number(!a.instances?.length) - Number(!b.instances?.length) || a.node.title.localeCompare(b.node.title));
  return el("table", { class: "knowledge-graph-table" },
    el("thead", {}, el("tr", {}, el("th", { scope: "col" }, "Knowledge graph"), el("th", { scope: "col" }, "Instances"))),
    el("tbody", {}, ...rows.map(({ node, instances, error }) => el("tr", {},
      el("th", { scope: "row" }, link(node.title, node.id)),
      el("td", {}, instances?.length
        ? el("div", { class: "knowledge-graph-links" }, ...instances.slice(0, firstInstances).map(({ root }) => instanceLink(graph, node, root)),
          ...(instances.length > firstInstances ? [link("more", node.id)] : []))
        : el("span", { class: "knowledge-graph-empty" }, error ? "No graph view" : "None yet"))))));
}
/** Every instance of one knowledge graph: what the definition and its graph view lead with. */
function knowledgeGraphInstanceList(graph: Graph, node: GraphNode, { instances, error } = instancesOf(graph, node)) {
  return el("section", { class: "knowledge-graph-instances" },
    el("h2", { class: "visually-hidden" }, "Instances"),
    instances?.length
      ? el("ul", {}, ...instances.map(({ root }) => el("li", {}, instanceLink(graph, node, root),
        el("span", { class: "knowledge-graph-instance-type" }, typeTitle(graph, root.typeId)))))
      : el("p", { class: "knowledge-graph-empty" }, error ? "This knowledge graph has no graph view." : "No record in this Wiki starts this knowledge graph yet."));
}
/**
 * A knowledge graph's own page: its instances first, and its definition
 * (`details`, then the traversal) behind a disclosure, open only when the
 * definition cannot be explored, so the reason is in view.
 */
export function knowledgeGraphOverview(graph: Graph, node: GraphNode, details: Node) {
  const definition = el("details", { class: "knowledge-graph-definition" }, el("summary", {}, "How this graph is built"), details, knowledgeGraphDefinition(graph, node));
  const found = instancesOf(graph, node);
  definition.open = !!found.error;
  return { instances: knowledgeGraphInstanceList(graph, node, found), definition };
}
