import type { Graph, GraphNode } from "../lib/graph";
import { historySection } from "./changes";
import {
  bodyGraphReferences,
  type BodyReferenceCheck,
} from "../lib/body-graph-references";
import {
  bodyObject,
  fieldValue,
  humanize,
  object,
  presentation,
  readableProgram,
  summary,
  type Presentation,
  type PresentationField,
} from "../lib/node-presentation";
import { el, entityUrl, link, notice } from "./data";

type Context = {
  graph: Graph;
  node: GraphNode;
  view?: Presentation;
  checks: BodyReferenceCheck[];
  showRelationships: boolean;
};
const text = (value: unknown): string => {
  if (value === undefined || value === null || value === "")
    return "Not recorded";
  if (Array.isArray(value)) return value.map(text).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};
const section = (title: string, ...children: (Node | string)[]) =>
  el("section", { class: "node-section" }, el("h2", {}, title), ...children);
export function nodeIdentity(graph: Graph, node: GraphNode, edit: () => void) {
  const type = graph.types.find((t) => t.id === node.typeId),
    view = presentation(type);
  const state = node.properties.state;
  const badge = state === "proposed" ? "Draft" : text(state);
  const version = node.properties.policy_version;
  return el(
    "header",
    { class: "node-identity" },
    el(
      "div",
      { class: "node-eyebrow" },
      type
        ? link(view?.entityLabel ?? humanize(type.name), type.id, "type")
        : "Entity",
      ...(state ? [el("span", { class: "node-badge" }, badge)] : []),
      ...(version
        ? [el("span", { class: "node-version" }, `Version ${version}`)]
        : []),
    ),
    el(
      "div",
      { class: "node-title-row" },
      el("h1", {}, node.title),
      graph.canEdit
        ? el("button", { type: "button", onclick: edit }, "Edit definition")
        : null,
    ),
    summary(node, view)
      ? el("p", { class: "node-summary" }, summary(node, view))
      : null,
    node.website && /^https?:\/\//i.test(node.website)
      ? el(
          "a",
          {
            href: node.website,
            class: "node-website",
            rel: "noopener noreferrer",
          },
          "Open website ↗",
        )
      : null,
  );
}
function valueTable(value: unknown) {
  if (!Array.isArray(value)) return keyValues(object(value));
  const rows = value.map(object),
    columns = [...new Set(rows.flatMap((row) => Object.keys(row)))].slice(0, 8);
  if (!columns.length)
    return el("ul", {}, ...value.map((item) => el("li", {}, text(item))));
  return el(
    "div",
    { class: "node-table-scroll", tabIndex: 0 },
    el(
      "table",
      { class: "node-table" },
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          ...columns.map((key) => el("th", { scope: "col" }, humanize(key))),
        ),
      ),
      el(
        "tbody",
        {},
        ...rows.map((row) =>
          el("tr", {}, ...columns.map((key) => el("td", {}, text(row[key])))),
        ),
      ),
    ),
  );
}
function keyValues(values: Record<string, unknown>) {
  return el(
    "dl",
    { class: "node-facts" },
    ...Object.entries(values).map(([key, value]) =>
      el("div", {}, el("dt", {}, humanize(key)), el("dd", {}, text(value))),
    ),
  );
}
function program(value: unknown, view?: Presentation) {
  const result = readableProgram(value, view?.inputLabels);
  if (result.decisions.length) return valueTable(result.decisions);
  return el("p", { class: "node-expression" }, result.expression);
}
function field(
  context: Context,
  definition: PresentationField,
  hideLabel = false,
) {
  const value = fieldValue(context.node, definition);
  let content: HTMLElement;
  if (definition.format === "expression" || definition.format === "decision")
    content = program(value, context.view);
  else if (definition.format === "table" || typeof value === "object")
    content = valueTable(value);
  else content = el("p", {}, text(value));
  return el(
    "div",
    { class: "node-field" },
    hideLabel ? null : el("h3", {}, definition.label),
    content,
    definition.description
      ? el("p", { class: "node-help" }, definition.description)
      : null,
  );
}
function configuredSections(context: Context, id: string) {
  const tab = context.view?.tabs.find((t) => t.id === id);
  return (
    tab?.sections.map((group) =>
      section(
        group.title,
        el(
          "div",
          { class: "node-field-grid" },
          ...group.fields.map((item) =>
            field(
              context,
              item,
              group.fields.length === 1 &&
                item.label.toLowerCase() === group.title.toLowerCase(),
            ),
          ),
        ),
      ),
    ) ?? []
  );
}
function nodeLinks(context: Context, ids: string[]) {
  return ids.flatMap((id) => {
    const node = context.graph.nodes.find((n) => n.id === id && !n.archived);
    if (!node) return [];
    const type = context.graph.types.find((t) => t.id === node.typeId);
    return [
      el(
        "span",
        { class: "node-reference" },
        link(node.title, node.id),
        el(
          "span",
          { class: "node-type-label" },
          humanize(type?.name ?? "Entity"),
        ),
      ),
    ];
  });
}
function relationships(context: Context) {
  const rows = context.checks.filter(
    (c) => c.kind === "graph" && c.nodeIds.length,
  );
  if (rows.length)
    return section(
      "Related entities",
      el(
        "dl",
        { class: "node-relationships" },
        ...rows.map((row) =>
          el(
            "div",
            {},
            el("dt", {}, humanize(row.label)),
            el("dd", {}, ...nodeLinks(context, row.nodeIds)),
          ),
        ),
      ),
    );
  const edges = context.graph.edges
    .filter(
      (e) =>
        !e.archived &&
        (e.fromId === context.node.id || e.toId === context.node.id),
    )
    .slice(0, 8);
  return section(
    "Related entities",
    edges.length
      ? el(
          "dl",
          { class: "node-relationships" },
          ...edges.map((edge) => {
            const type = context.graph.types.find((t) => t.id === edge.typeId);
            const outgoing = edge.fromId === context.node.id;
            return el(
              "div",
              {},
              el(
                "dt",
                {},
                `${outgoing ? "" : "Referenced by · "}${humanize(type?.title ?? "Related")}`,
              ),
              el(
                "dd",
                {},
                ...nodeLinks(context, [outgoing ? edge.toId : edge.fromId]),
              ),
            );
          }),
        )
      : el("p", { class: "node-help" }, "No relationships recorded."),
  );
}
function readiness(context: Context, showData: () => void) {
  const unbound = context.checks.filter(
    (c) => c.kind === "binding" && c.status === "missing",
  );
  const missing = context.checks.filter(
    (c) => c.kind === "graph" && c.status === "missing",
  );
  if (!unbound.length && !missing.length) return null;
  const title = unbound.length
    ? "Data source not configured"
    : "Missing connections";
  return el(
    "aside",
    { class: "node-readiness", role: "status" },
    el(
      "div",
      {},
      el("strong", {}, title),
      el(
        "p",
        {},
        unbound.length
          ? "This definition has no bound data source. No evaluated result is available here."
          : `${missing.length} required connection${missing.length === 1 ? " is" : "s are"} missing from this Wiki.`,
      ),
    ),
    el("button", { type: "button", onclick: showData }, "Review requirements"),
  );
}
function requirements(context: Context) {
  const checks = context.checks;
  const rows = checks.map((check) => ({
    requirement: humanize(check.label),
    status:
      check.status === "missing"
        ? "Missing"
        : check.kind === "binding"
          ? "Declared"
          : "Connected",
    detail: check.detail,
  }));
  return section(
    "Data readiness",
    el(
      "p",
      { class: "node-help" },
      "Connections describe this definition. They do not prove provider access, evidence coverage or an active evaluation.",
    ),
    rows.length
      ? valueTable(rows)
      : el("p", {}, "No graph or data requirements declared."),
  );
}
function technical(context: Context) {
  const type = context.graph.types.find((t) => t.id === context.node.typeId);
  const body = bodyObject(context.node);
  const spec =
    typeof body === "undefined"
      ? context.node.body
      : JSON.stringify(body, null, 2);
  const copy = el(
    "button",
    {
      type: "button",
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(spec);
          notice("Definition copied.");
        } catch {
          notice("Could not copy the definition.");
        }
      },
    },
    "Copy definition",
  );
  return el(
    "div",
    { class: "node-tab-content" },
    section(
      "Stored definition",
      el(
        "p",
        { class: "node-help" },
        "Source representation for review and tooling. Displaying a definition does not execute it.",
      ),
      copy,
      el("pre", { class: "node-code" }, spec),
    ),
    section("Record properties", keyValues(context.node.properties)),
    historySection(context.node.id),
    context.node.source
      ? section("Source reference", keyValues(context.node.source))
      : null,
    requirements(context),
    type?.jsonSchema
      ? el(
          "details",
          { class: "node-section" },
          el("summary", {}, "Body JSON Schema"),
          el(
            "pre",
            { class: "node-code" },
            JSON.stringify(type.jsonSchema, null, 2),
          ),
        )
      : null,
  );
}
function overview(context: Context, documentation: () => HTMLElement) {
  const groups = configuredSections(context, "overview");
  if (!groups.length) {
    const body = bodyObject(context.node);
    const assertion = context.graph.types.find(
      (type) => type.id === context.node.typeId,
    )?.ontology;
    groups.push(
      body === undefined ||
        (assertion?.version === 2 && assertion.stereotype === "assertion")
        ? documentation()
        : section("Definition", valueTable(body)),
    );
    const facts = Object.fromEntries(
      Object.entries(context.node.properties).filter(
        ([key, value]) =>
          key !== "organization_id" && !key.includes("formula") && String(value).length < 180,
      ),
    );
    if (Object.keys(facts).length)
      groups.push(section("Key facts", keyValues(facts)));
  }
  if (!context.showRelationships)
    return el("div", { class: "node-main" }, ...groups);
  return el(
    "div",
    { class: "node-overview-grid" },
    el("div", { class: "node-main" }, ...groups),
    el("aside", { class: "node-aside" }, relationships(context)),
  );
}
function tabs(context: Context) {
  const extras =
    context.view?.tabs.filter(
      (tab) => tab.id !== "overview" && tab.id !== "technical",
    ) ?? [];
  return [
    { id: "overview", label: "Overview" },
    ...extras,
    { id: "technical", label: "Technical" },
  ];
}
/** Generic node reader. App meaning comes from the type's presentation metadata. */
export function nodeDetails(
  graph: Graph,
  node: GraphNode,
  documentation: () => HTMLElement,
  options: { showRelationships?: boolean } = {},
) {
  const type = graph.types.find((t) => t.id === node.typeId);
  const context: Context = {
    graph,
    node,
    view: presentation(type),
    checks: bodyGraphReferences(graph, node, type?.jsonSchema),
    showRelationships: options.showRelationships !== false,
  };
  const element = el("div", { class: "node-reader" }),
    content = el("div", { role: "tabpanel", id: "node-panel", tabIndex: 0 });
  const definitions = tabs(context),
    buttons: HTMLButtonElement[] = [];
  const select = (id: string) => {
    for (const button of buttons) {
      const selected = button.dataset.tab === id;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    const selected = buttons.find((button) => button.dataset.tab === id);
    if (selected) content.setAttribute("aria-labelledby", selected.id);
    if (id === "overview")
      content.replaceChildren(overview(context, documentation));
    else if (id === "technical") content.replaceChildren(technical(context));
    else {
      content.replaceChildren(...configuredSections(context, id));
      if (id === "data")
        content.insertBefore(requirements(context), content.firstChild);
    }
  };
  for (const definition of definitions) {
    const button = el(
      "button",
      {
        id: `node-tab-${definition.id}`,
        type: "button",
        role: "tab",
        "aria-controls": "node-panel",
        onclick: () => select(definition.id),
      },
      definition.label,
    );
    button.dataset.tab = definition.id;
    buttons.push(button);
  }
  const tablist = el(
    "div",
    { role: "tablist", "aria-label": "Node details", class: "node-tabs" },
    ...buttons,
  );
  tablist.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) %
            buttons.length;
    event.preventDefault();
    buttons[next].click();
    buttons[next].focus();
  });
  element.appendChild(
    el(
      "div",
      { class: "node-navigation" },
      tablist,
      el(
        "nav",
        { "aria-label": "Explore entity", class: "node-explore" },
        el("a", { href: `${entityUrl(node.id)}/connections` }, "Connections"),
        el("a", { href: `${entityUrl(node.id)}/knowledge-graphs` }, "Graph"),
        ...(["Organization", "Board"].includes(type?.name ?? "") ? [el("a", { href: `${entityUrl(node.id)}/org-chart` }, "Org chart")] : []),
      ),
    ),
  );
  const banner = readiness(context, () =>
    select(definitions.some((tab) => tab.id === "data") ? "data" : "technical"),
  );
  if (banner) element.appendChild(banner);
  element.appendChild(content);
  select("overview");
  return element;
}
