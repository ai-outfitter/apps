import { orgChartView, orgChartLinks } from "./org-chart";
import { nodeIdentity, nodeDetails } from "./node-details";
import { assertionReview } from "./assertions";
import { structuredBodyMarkdown } from "../lib/structured-body";
import { micromark } from "micromark";
import {
  core,
  type Graph,
  type GraphNode,
  type TypeDefinition,
} from "../lib/graph";
import { appUrl, call, el, entityUrl, link, loadGraph, notice, typeName as registryName, typeSegment } from "./data";
import { connections } from "./connections";
import contextGraphSchema from "../../schemas/knowledge-graph-definition.json";
import { knowledgeGraphViews, knowledgeGraphOverview, knowledgeGraphTable } from "./knowledge-graphs";
import { parseGraphQuery } from "../lib/knowledge-graph-query";
import { agentPage } from "@ai-outfitter/app-sdk/agent-context";

let root = document.getElementById("graph");
let params = new URLSearchParams(location.search);
const input = (value = "") => el("input", { value });
const area = (value = "") => el("textarea", { value, rows: 10 });
const label = (name: string, field: Node) => el("label", {}, name, field);
const heading = (title: string) => {
  const pageHeading = document.querySelector("h1");
  if (pageHeading && !root?.contains(pageHeading)) {
    pageHeading.textContent = title;
    return document.createTextNode("");
  }
  return el("h1", {}, title);
};
const button = (title: string, action: () => void) =>
  el("button", { type: "button", onclick: action }, title);
const option = (value: string, title: string) => el("option", { value }, title);
const typeName = (g: Graph, id: string) =>
  g.types.find((t) => t.id === id)?.title ?? "Entity";
const go = (id: string, typeId?: string) => {
  location.href = entityUrl(id, typeId);
};
const active = (g: Graph) => g.nodes.filter((n) => !n.archived);
async function createNode(typeId: string, title: string, body = "") {
  return call<{ ref: { id: string } }>("graph/create", {
    type: "graph-node",
    attributes: { typeId, title, body },
  });
}
async function connect(
  typeId: string,
  fromId: string,
  toId: string,
  properties: Record<string, string> = {},
) {
  return call("graph/create", {
    type: "graph-edge",
    attributes: { typeId, fromId, toId, properties },
  });
}
function form(
  root: HTMLElement,
  title: string,
  fields: Node[],
  save: () => Promise<void>,
  saveTitle = "Save",
) {
  const submit = el("button", { type: "submit" }, saveTitle);
  const element = el(
    "form",
    { class: "graph-form" },
    heading(title),
    ...fields,
    submit,
  );
  element.onsubmit = async (event) => {
    event.preventDefault();
    submit.disabled = true;
    notice("");
    try {
      await save();
    } catch (error) {
      notice(error instanceof Error ? error.message : String(error));
    } finally {
      submit.disabled = false;
    }
  };
  root.replaceChildren(element);
}
async function projectForm(root: HTMLElement) {
  root.replaceChildren(
    heading("Create or link project"),
    el("p", {}, "Loading Planning projects…"),
  );
  const choices = await call<{
    installations: string[];
    projects: {
      ref: { installationId: string; type: string; id: string };
      title: string;
    }[];
  }>("projects");
  const mode = el(
    "select",
    {},
    ...(choices.installations.length ? [
      option("create", "Create in Planning"),
      option("link", "Link an existing Planning project"),
    ] : []),
    option("standalone", "Document an external project"),
  );
  const installation = el(
    "select",
    {},
    ...choices.installations.map((id) =>
      option(
        id,
        choices.installations.length === 1 ? "Planning" : `Planning · ${id}`,
      ),
    ),
  );
  const existing = el(
    "select",
    {},
    ...choices.projects.map((p, i) =>
      option(String(i), `${p.title} · ${p.ref.id.slice(0, 8)}`),
    ),
  );
  const name = input(),
    body = area();
  name.required = true;
  name.maxLength = 120;
  const nameField = label("Project name", name),
    existingField = label("Existing project", existing);
  const installationField = label("Project app", installation);
  const refresh = () => {
    installationField.hidden = mode.value === "standalone";
    nameField.hidden = mode.value === "link";
    existingField.hidden = mode.value !== "link";
    name.required = mode.value !== "link";
  };
  mode.onchange = refresh;
  refresh();
  let retry: { installationId: string; type: string; id: string } | null = null;
  form(
    root,
    "Create or link project",
    [
      label("How would you like to start?", mode),
      installationField,
      el("p", {}, "External projects are documented in this Wiki. Link their organization using Connections."),
      nameField,
      existingField,
      label("Documentation (Markdown)", body),
    ],
    async () => {
      if (mode.value === "standalone") {
        go((await createNode(core.project, name.value, body.value)).ref.id, core.project);
        return;
      }
      const reference = retry ?? choices.projects[Number(existing.value)]?.ref;
      if (mode.value === "link" && !reference)
        throw new Error("Select an existing project.");
      const result = await call<{
        node: GraphNode | null;
        project: { ref: typeof reference };
        error?: string;
      }>(
        "projects",
        retry || mode.value === "link"
          ? { mode: "link", reference, body: body.value }
          : {
              mode: "create",
              installationId: installation.value,
              name: name.value,
              body: body.value,
            },
      );
      if (!result.node) {
        retry = result.project.ref!;
        throw new Error(
          result.error ??
            "Retry to finish documentation for the saved project.",
        );
      }
      go(result.node.id, core.project);
    },
    "Save project",
  );
}
function newEntity(root: HTMLElement, kind: string) {
  const definitions: Record<string, [string, string]> = {
    person: [core.person, "person"],
    organization: [core.organization, "organization"],
    technology: [core.technology, "technology"],
    product: [core.product, "product"],
  };
  const [typeId, title] = definitions[kind] ?? definitions.person;
  const name = input(),
    body = area();
  name.required = true;
  name.maxLength = 120;
  form(
    root,
    `Add ${title}`,
    [label("Name", name), label("Documentation (Markdown)", body)],
    async () => go((await createNode(typeId, name.value, body.value)).ref.id, typeId),
  );
}
function group(node: GraphNode) {
  if (node.typeId === core.project) return "Projects";
  if ([core.person, core.agent].includes(node.typeId))
    return "People";
  if ([core.organization, core.unit].includes(node.typeId))
    return "Organizations";
  if ([core.technology, core.component].includes(node.typeId))
    return "Technologies";
  if (node.typeId === core.product) return "Products";
  if (node.typeId === core.customerSegment) return "Customer segments";
  if (node.typeId === core.problem) return "Customer problems";
  if (node.typeId === core.offering) return "Offerings";
  if (node.typeId === core.knowledgeGraph) return "Knowledge graphs";
  if (node.typeId === core.decisionRecord) return "Decision records";
  if ([core.role, core.roleAssignment].includes(node.typeId)) return "Roles and assignments";
  if ([core.decisionType, core.authorityDefinition, core.authorityGrant].includes(node.typeId)) return "Decision authority";
  return "Other context";
}
function typeCards(g: Graph, query = "", category?: "node" | "edge") {
  return el(
    "ul",
    { class: "wiki-cards" },
    ...g.types
      .filter(
        (t) =>
          !t.archived &&
          (!category || t.category === category) &&
          `${t.title} ${t.name} ${t.body}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      )
      .map((t) =>
        el(
          "li",
          { class: "wiki-card" },
          link(t.title, t.id, "type"),
          el(
            "small",
            {},
            t.category === "node" ? "Entity type" : "Connection type",
          ),
        ),
      ),
  );
}
function typePage(root: HTMLElement, g: Graph, type: TypeDefinition) {
  const body = el("div", { class: "documentation" });
  body.innerHTML = micromark(type.body, {
    allowDangerousHtml: false,
    allowDangerousProtocol: false,
  });
  const examples = active(g).filter((n) => n.typeId === type.id);
  root.replaceChildren(
    heading(type.title),
    el("p", {}, type.category === "node" ? "Entity type" : "Connection type"),
    body,
    el("a", { href: appUrl("types") }, "All types"),
  );
  if (examples.length)
    root.appendChild(
      el(
        "section",
        { class: "graph-section" },
        el("h2", {}, "In this Wiki"),
        el("ul", {}, ...examples.map((n) => el("li", {}, link(n.title, n.id)))),
      ),
    );
}
function typesPage(root: HTMLElement, g: Graph) {
  const introduction = el("div", { class: "documentation" });
  const entity = g.types.find((t) => t.id === core.entity);
  introduction.innerHTML = micromark(
    entity?.body ?? "Types explain the shared graph.",
    { allowDangerousHtml: false, allowDangerousProtocol: false },
  );
  root.replaceChildren(
    heading("Types"),
    introduction,
    el(
      "section",
      { class: "graph-section" },
      el("h2", {}, "Entity types"),
      typeCards(g, "", "node"),
    ),
    el(
      "section",
      { class: "graph-section" },
      el("h2", {}, "Connection types"),
      typeCards(g, "", "edge"),
    ),
  );
}
function organizationLinkTypes(g: Graph) {
  return new Set(g.types.filter((type) => ["part_of", "designed_by"].includes(type.name)).map((type) => type.id));
}
function projectOrganizations(g: Graph, project: GraphNode) {
  const links = organizationLinkTypes(g);
  const ids = new Set(g.edges.filter((edge) => !edge.archived && edge.fromId === project.id && links.has(edge.typeId)).map((edge) => edge.toId));
  return active(g).filter((node) => node.typeId === core.organization && ids.has(node.id)).sort((a, b) => a.title.localeCompare(b.title));
}
function measurementSummary(g: Graph, node: GraphNode) {
  const targets = (id: string) => g.edges.filter((edge) => !edge.archived && edge.typeId === core.measured && edge.fromId === id)
    .flatMap((edge) => {
      const target = g.nodes.find((candidate) => candidate.id === edge.toId && !candidate.archived);
      return target ? [{ target, edge }] : [];
    });
  const measures = targets(node.id);
  return el("div", {}, ...(measures.length ? measures.map(({ target, edge }) =>
    el("small", {}, "Measured by: ", link(target.title, target.id),
      edge.properties.status ? ` (${edge.properties.status})` : "",
      ...targets(target.id).filter(({ target: source }) => source.id !== node.id && source.id !== target.id)
        .map(({ target: source, edge: sourceEdge }) => el("span", {}, " · Source: ", link(source.title, source.id), sourceEdge.properties.status ? ` (${sourceEdge.properties.status})` : "")),
    ),
  ) : [el("small", {}, "Measured by: not linked yet")]));
}
function goalCard(g: Graph, node: GraphNode, context?: HTMLElement) {
  return el("li", { class: "wiki-card" }, link(node.title, node.id), measurementSummary(g, node), context ?? null, node.summary ? el("p", {}, node.summary) : null);
}
function linkedNodes(g: Graph, id: string, edgeType: string, incoming = false) {
  const ids = new Set(g.edges.filter((edge) => !edge.archived && (incoming ? edge.toId : edge.fromId) === id && edge.typeId === edgeType).map((edge) => incoming ? edge.fromId : edge.toId));
  return active(g).filter((node) => ids.has(node.id));
}
function roleDecisions(g: Graph, role: GraphNode) {
  const grants = linkedNodes(g, role.id, core.hasAuthorityGrant).filter((node) => node.typeId === core.authorityGrant);
  const definitions = grants.flatMap((grant) => linkedNodes(g, grant.id, core.definedBy)).filter((node) => node.typeId === core.authorityDefinition);
  const decisions = definitions.flatMap((definition) => linkedNodes(g, definition.id, core.permits)).filter((node) => node.typeId === core.decisionType);
  return [...new Map(decisions.map((node) => [node.id, node])).values()];
}
function assignmentCard(g: Graph, assignment: GraphNode) {
  const roles = linkedNodes(g, assignment.id, core.assignsRole).filter((node) => node.typeId === core.role);
  const holders = linkedNodes(g, assignment.id, core.assignedTo).filter((node) => [core.person, core.agent].includes(node.typeId));
  const scopes = linkedNodes(g, assignment.id, core.scopedTo).filter((node) => [core.organization, core.unit, core.project].includes(node.typeId));
  const decisions = roles.length === 1 && holders.length === 1 && scopes.length === 1 ? roleDecisions(g, roles[0]) : [];
  const fields = [["Role", roles], ["Holder", holders], ["Scope", scopes]] as const;
  return el("li", { class: "wiki-card" }, link(assignment.title, assignment.id),
    ...fields.map(([label, targets]) => el("div", {}, el("small", {}, `${label}: `,
      ...(targets.length ? targets.flatMap((target, index) => [index ? ", " : "", link(target.title, target.id)]) : ["Not linked"])))),
    ...decisions.map((decision) => el("div", {}, el("small", {}, "Decision authority: ", link(decision.title, decision.id)))),
  );
}
function roleAssignments(g: Graph, node: GraphNode) {
  const relationTypes = new Set([core.assignedTo, core.assignsRole, core.scopedTo]);
  const ids = new Set(g.edges.filter((edge) => !edge.archived && relationTypes.has(edge.typeId) && edge.toId === node.id).map((edge) => edge.fromId));
  const assignments = active(g).filter((candidate) => candidate.typeId === core.roleAssignment && (candidate.id === node.id || ids.has(candidate.id)))
    .sort((a, b) => a.title.localeCompare(b.title));
  return assignments.length ? el("section", { class: "graph-section" }, el("h2", {}, "Role assignments"),
    el("ul", { class: "wiki-cards" }, ...assignments.map((assignment) => assignmentCard(g, assignment)))) : null;
}
function formatPrice(properties: GraphNode["properties"], unknown = "Pricing not specified") {
  const { price, currency, billing_interval: interval } = properties;
  if (typeof price !== "number") return unknown;
  return `${price}${typeof currency === "string" && currency ? ` ${currency}` : " (currency not specified)"}${typeof interval === "string" && interval ? ` · ${interval}` : ""}`;
}
function offeringPrice(node: GraphNode) {
  const { price } = node.properties;
  if (typeof price !== "number") {
    if (node.properties.pricing_model === "cost_plus")
      return typeof node.properties.markup_percent === "number" ? `Provider cost + ${node.properties.markup_percent}% markup` : "Provider cost + markup (rate not specified)";
    if (node.properties.pricing_model === "role_based") return "Role-based pricing — see role rates";
    return "Pricing not specified";
  }
  return formatPrice(node.properties);
}
function offeringCard(g: Graph, offering: GraphNode) {
  const products = linkedNodes(g, offering.id, core.packagesProduct);
  return el("li", { class: "wiki-card" }, link(offering.title, offering.id),
    ...products.map((product) => el("div", {}, el("small", {}, "Product: ", link(product.title, product.id)))),
    el("small", {}, offeringPrice(offering)),
    offering.summary ? el("p", {}, offering.summary) : null);
}
function organizationProductRows(g: Graph, organization: GraphNode) {
  const products = new Map<string, { product: GraphNode; sources: Map<string, GraphNode> }>();
  const add = (product: GraphNode, source?: GraphNode) => {
    if (![core.product, core.component].includes(product.typeId)) return;
    const row = products.get(product.id) ?? { product, sources: new Map<string, GraphNode>() };
    if (source && source.id !== organization.id) row.sources.set(source.id, source);
    products.set(product.id, row);
  };
  for (const producer of [organization, ...organizationProjects(g, organization).values()])
    for (const product of linkedNodes(g, producer.id, core.produces)) add(product, producer);
  for (const offering of organizationOfferingNodes(g, organization))
    for (const product of linkedNodes(g, offering.id, core.packagesProduct)) add(product, offering);
  for (const relation of [core.designed, core.developed, core.manufactured])
    for (const product of linkedNodes(g, organization.id, relation, true)) add(product);
  return [...products.values()].sort((a, b) => a.product.title.localeCompare(b.product.title));
}
function organizationProducts(g: Graph, organization: GraphNode) {
  const rows = organizationProductRows(g, organization);
  return el("section", { class: "graph-section" }, el("h2", {}, "Products"),
    rows.length ? el("ul", { class: "wiki-cards" }, ...rows.map(({ product, sources }) =>
      el("li", { class: "wiki-card" }, link(product.title, product.id),
        ...[...sources.values()].map((source) => el("small", {}, source.typeId === core.project ? "Project: " : "Offering: ", link(source.title, source.id))),
        product.summary ? el("p", {}, product.summary) : null)))
      : el("p", {}, "No products linked to this organization yet."));
}
function organizationOfferingNodes(g: Graph, organization: GraphNode) {
  return linkedNodes(g, organization.id, core.offeredBy, true).filter((node) => node.typeId === core.offering).sort((a, b) => a.title.localeCompare(b.title));
}
function organizationOfferings(g: Graph, organization: GraphNode) {
  const offerings = organizationOfferingNodes(g, organization);
  return el("section", { class: "graph-section" }, el("h2", {}, "Offerings"),
    offerings.length ? el("ul", { class: "wiki-cards" }, ...offerings.map((offering) => offeringCard(g, offering)))
      : el("p", {}, "No offerings linked to this organization yet."));
}
function entityCard(g: Graph, node: GraphNode) {
  if (node.typeId === core.offering) return offeringCard(g, node);
  if (node.typeId === core.roleAssignment) return assignmentCard(g, node);
  if (node.typeId === core.goal) return goalCard(g, node);
  const subtext = node.typeId === core.project
    ? projectOrganizations(g, node).map((organization) => organization.title).join(", ") || "No organization linked"
    : typeName(g, node.typeId);
  return el("li", { class: "wiki-card" }, link(node.title, node.id), el("small", {}, subtext), node.summary ? el("p", {}, node.summary) : null);
}
function matchesCollection(node: GraphNode, collection: TypeDefinition | undefined, title: string) {
  return collection ? node.typeId === collection.id : group(node) === title;
}
function creationActions(collection?: TypeDefinition) {
  return el(
        "nav",
        { class: "graph-actions" },
        ...(!collection || collection.id === core.project ? [el("a", { href: appUrl("page?new=project") }, "Create/link project")] : []),
        ...(!collection || collection.id === core.person ? [el("a", { href: appUrl("page?new=person") }, "Add person")] : []),
        ...(!collection || collection.id === core.organization ? [el("a", { href: appUrl("page?new=organization") }, "Add organization")] : []),
        ...(!collection || collection.id === core.product ? [el("a", { href: appUrl("page?new=product") }, "Add product")] : []),
        ...(!collection || collection.id === core.technology ? [el("a", { href: appUrl("page?new=technology") }, "Add technology")] : []),
      );
}
function home(root: HTMLElement, g: Graph, collection?: TypeDefinition) {
  const search = input();
  search.type = "search";
  const lists = el("div", { class: "wiki-map" });
  const draw = () => {
    lists.replaceChildren();
    for (const title of collection ? [collection.title] : [
      "Projects",
      "People",
      "Organizations",
      "Technologies",
      "Products",
      "Customer segments",
      "Customer problems",
      "Offerings",
      "Knowledge graphs",
      "Roles and assignments",
      "Decision authority",
      "Decision records",
      "Other context",
    ]) {
      const nodes = active(g).filter(
        (n) =>
          matchesCollection(n, collection, title) &&
          `${n.title} ${n.summary} ${n.body}`
            .toLowerCase()
            .includes(search.value.toLowerCase()),
      );
      if (title === "Other context" && !nodes.length) continue;
      const items = el(
        "ul",
        { class: "wiki-cards" },
        ...nodes.map((node) => entityCard(g, node)),
      );
      lists.appendChild(
        el(
          "section",
          { class: "graph-section" },
          el("h2", {}, title),
          nodes.length ? items : el("p", {}, "No matches."),
        ),
      );
    }
    if (!collection) lists.appendChild(
      el(
        "section",
        { class: "graph-section" },
        el("h2", {}, "Types"),
        el(
          "p",
          {},
          "The building blocks people and agents use to describe shared context.",
        ),
        el("a", { href: appUrl("types") }, "About the graph"),
        typeCards(g, search.value),
      ),
    );
  };
  search.oninput = draw;
  draw();
  root.replaceChildren(
    heading(collection?.title ?? "Projects and shared context"),
    el(
      "p",
      {},
      collection ? `Browse ${collection.title.toLowerCase()} in this wiki.` : "Find projects, people, organizations and the technology they use.",
    ),
    label(
      collection ? `Search ${collection.title.toLowerCase()}` : "Search projects, people, organizations, technologies and types",
      search,
    ),
  );
  if (g.canEdit) root.appendChild(creationActions(collection));
  root.appendChild(lists);
}
function documentation(root: HTMLElement, node: GraphNode) {
  const body = area(node.body),
    summary = input(node.summary);
  form(
    root,
    `Edit documentation: ${node.title}`,
    [label("Summary", summary), label("Documentation (Markdown)", body)],
    async () => {
      await call("graph/update", {
        type: "graph-node",
        id: node.id,
        revision: node.revision,
        attributes: { body: body.value, summary: summary.value },
        references: node.source ? [node.source] : [],
      });
      go(node.id);
    },
  );
}
function addConnection(
  root: HTMLElement,
  g: Graph,
  project: GraphNode,
  action: string,
) {
  const config: Record<
    string,
    {
      title: string;
      typeId: string;
      targetTypes: string[];
      edge: string;
      incoming?: boolean;
    }
  > = {
    participant: {
      title: "Add participant",
      typeId: core.person,
      targetTypes: [core.person, core.agent],
      edge: core.participates,
      incoming: true,
    },
    dependency: {
      title: "Add dependency",
      typeId: core.product,
      targetTypes: [core.technology, core.component, core.product],
      edge: core.uses,
    },
    unit: {
      title: "Set business unit",
      typeId: core.unit,
      targetTypes: [core.unit, core.organization],
      edge: core.belongs,
    },
    goal: {
      title: "Add goal",
      typeId: core.goal,
      targetTypes: [core.goal],
      edge: core.pursues,
    },
  };
  const configRow = config[action];
  if (!configRow) return entityPage(root, g, project);
  const choices = active(g).filter((n) =>
    configRow.targetTypes.includes(n.typeId),
  );
  const selection = el(
    "select",
    {},
    option("", "Create new…"),
    ...choices.map((n) => option(n.id, `${n.title} · ${n.id.slice(0, 8)}`)),
  );
  const name = input(),
    body = area(),
    status = el(
      "select",
      {},
      option("proposed", "Proposed"),
      option("observed", "Observed"),
    );
  const newFields = el(
    "div",
    { class: "graph-fields" },
    label("Name", name),
    label("Notes (Markdown)", body),
  );
  name.required = true;
  name.maxLength = 120;
  selection.onchange = () => {
    newFields.hidden = Boolean(selection.value);
    name.required = !selection.value;
  };
  form(
    root,
    configRow.title,
    [
      label("Choose existing or create new", selection),
      newFields,
      ...(action === "dependency" ? [label("Status", status)] : []),
    ],
    async () => {
      const target =
        selection.value ||
        (await createNode(configRow.typeId, name.value, body.value)).ref.id;
      const from = configRow.incoming ? target : project.id,
        to = configRow.incoming ? project.id : target;
      const currentUnit =
        action === "unit"
          ? g.edges.find(
              (e) =>
                !e.archived &&
                e.typeId === core.belongs &&
                e.fromId === project.id,
            )
          : undefined;
      if (currentUnit)
        await call("graph/update", {
          type: "graph-edge",
          id: currentUnit.id,
          revision: currentUnit.revision,
          attributes: { toId: target },
        });
      else
        await connect(
          configRow.edge,
          from,
          to,
          action === "dependency" ? { status: status.value } : {},
        );
      go(project.id);
    },
    "Add",
  );
}
function projectSection(
  g: Graph,
  node: GraphNode,
  title: string,
  edgeType: string,
  incoming = false,
) {
  const edges = g.edges.filter(
    (e) =>
      !e.archived &&
      e.typeId === edgeType &&
      (incoming ? e.toId : e.fromId) === node.id,
  );
  const rows = edges.flatMap((edge) => {
    const target = g.nodes.find(
      (n) => n.id === (incoming ? edge.fromId : edge.toId) && !n.archived,
    );
    if (target?.typeId === core.goal) return [goalCard(g, target)];
    return target
      ? [
          el(
            "li",
            {},
            link(target.title, target.id),
            edge.properties.status ? ` · ${edge.properties.status}` : "",
          ),
        ]
      : [];
  });
  return el(
    "section",
    { class: "graph-section" },
    el("h2", {}, title),
    rows.length ? el("ul", [core.pursues, core.establishes].includes(edgeType) ? { class: "wiki-cards" } : {}, ...rows) : el("p", {}, "None added yet."),
  );
}
function organizationProjects(g: Graph, organization: GraphNode) {
  const nodes = new Map(active(g).map((node) => [node.id, node]));
  const projectLinks = organizationLinkTypes(g);
  const projects = new Map(g.edges.filter((edge) => !edge.archived && edge.toId === organization.id && projectLinks.has(edge.typeId))
    .map((edge) => nodes.get(edge.fromId))
    .filter((node): node is GraphNode => node?.typeId === core.project)
    .map((node) => [node.id, node]));
  return projects;
}
function organizationProjectList(g: Graph, organization: GraphNode) {
  const projects = [...organizationProjects(g, organization).values()].sort((a, b) => a.title.localeCompare(b.title));
  return el("section", { class: "graph-section" }, el("h2", {}, "Projects"),
    projects.length ? el("ul", { class: "wiki-cards" }, ...projects.map((project) => entityCard(g, project)))
      : el("p", {}, "No projects linked to this organization yet."));
}
function organizationGoals(g: Graph, organization: GraphNode) {
  const nodes = new Map(active(g).map((node) => [node.id, node]));
  const projects = organizationProjects(g, organization);
  const goals = new Map<string, { goal: GraphNode; direct: boolean; projects: Map<string, GraphNode> }>();
  for (const edge of g.edges) {
    if (edge.archived || edge.typeId !== core.pursues || (edge.fromId !== organization.id && !projects.has(edge.fromId))) continue;
    const goal = nodes.get(edge.toId);
    if (!goal || goal.typeId !== core.goal) continue;
    const item = goals.get(goal.id) ?? { goal, direct: false, projects: new Map<string, GraphNode>() };
    if (edge.fromId === organization.id) item.direct = true;
    else item.projects.set(edge.fromId, projects.get(edge.fromId)!);
    goals.set(goal.id, item);
  }
  const ordered = [...goals.values()].sort((a, b) => a.goal.title.localeCompare(b.goal.title));
  const rows = ordered.slice(0, 10).map(({ goal, direct, projects: sources }) =>
    goalCard(g, goal,
      el("div", {},
        ...(direct ? [el("small", {}, "Organization goal")] : []),
        ...[...sources.values()].sort((a, b) => a.title.localeCompare(b.title)).map((project) =>
          el("small", {}, " · via ", link(project.title, project.id))),
      )),
  );
  return el("section", { class: "graph-section" }, el("h2", {}, "Goals"),
    el("p", {}, "Organization goals and goals from its projects."),
    rows.length ? el("ul", { class: "wiki-cards" }, ...rows) : el("p", {}, "No goals added to this organization or its projects yet."),
    ordered.length > 10 ? el("p", {}, `Showing 10 of ${ordered.length} goals.`) : null,
  );
}

function repositoryForm(root: HTMLElement, g: Graph, project: GraphNode) {
  const url = input(), path = input(), ref = input("main");
  url.type = "url"; url.required = true; url.placeholder = "https://github.com/owner/repository";
  path.placeholder = "Leave empty for the whole repository";
  form(root, "Link repository", [label("GitHub repository URL", url), label("Directory within repository (optional)", path), label("Branch, tag or commit", ref)], async () => {
    const parsed = new URL(url.value.trim());
    const parts = parsed.pathname.replace(/\/$/, "").split("/").filter(Boolean);
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.username || parsed.password || parts.length !== 2 || parts.some((p) => p === "." || p === ".."))
      throw new Error("Use a GitHub repository URL, such as https://github.com/owner/repository.");
    const directory = path.value.trim().replace(/^\/+|\/+$/g, "");
    if (directory.includes("\\") || directory.split("/").some((p) => p === "." || p === "..")) throw new Error("Use a directory relative to the repository root.");
    const website = `https://github.com/${parts[0]}/${parts[1]}`;
    let repository = active(g).find((node) => node.typeId === core.repository && node.website?.toLowerCase() === website.toLowerCase());
    let id = repository?.id;
    if (!id) {
      const result = await call<{ ref: { id: string } }>("graph/create", { type: "graph-node", attributes: { typeId: core.repository, title: parts.join("/"), website } });
      id = result.ref.id;
    }
    const current = g.edges.find((edge) => edge.typeId === core.sourceIn && edge.fromId === project.id && edge.toId === id);
    await call(`graph/${current ? "update" : "create"}`, { type: "graph-edge", ...(current ? { id: current.id, revision: current.revision } : {}), attributes: { typeId: core.sourceIn, fromId: project.id, toId: id, properties: { path: directory, ref: ref.value.trim() }, archived: false } });
    go(project.id);
  }, "Save repository link");
}
function projectRepositories(root: HTMLElement, g: Graph, project: GraphNode) {
  const repositories = g.edges.filter((edge) => !edge.archived && edge.typeId === core.sourceIn && edge.fromId === project.id).flatMap((edge) => {
    const repository = active(g).find((node) => node.id === edge.toId && node.typeId === core.repository);
    if (!repository) return [];
    const path = typeof edge.properties.path === "string" ? edge.properties.path : "";
    const ref = typeof edge.properties.ref === "string" && edge.properties.ref ? edge.properties.ref : "HEAD";
    const url = repository.website;
    let browse = url;
    if (url && new URL(url).hostname === "github.com" && path && !path.split("/").some((p) => p === "." || p === ".."))
      browse = `${url.replace(/\/$/, "")}/tree/${encodeURIComponent(ref)}/${path.split("/").map(encodeURIComponent).join("/")}`;
    return [el("li", {}, link(repository.title, repository.id), el("div", {}, path ? `Directory: ${path}` : "Whole repository"), browse ? el("a", { href: browse }, "Browse source") : null)];
  });
  return el("section", { class: "graph-section" }, el("h2", {}, "Repositories"), repositories.length ? el("ul", {}, ...repositories) : el("p", {}, "No repository linked yet."), g.canEdit ? button("Link repository", () => repositoryForm(root, g, project)) : null);
}

function offeringPricing(g: Graph, node: GraphNode) {
  const rates = g.edges.filter((edge) => !edge.archived && edge.fromId === node.id && edge.typeId === core.pricedByRole)
    .flatMap((edge) => {
      const role = active(g).find((candidate) => candidate.id === edge.toId && candidate.typeId === core.role);
      if (!role) return [];
      const rate = formatPrice(edge.properties, "Rate not specified");
      return [{ role, rate }];
    }).sort((a, b) => a.role.title.localeCompare(b.role.title));
  const interval = node.properties.billing_interval;
  return el("section", { class: "graph-section" }, el("h2", {}, "Pricing"),
    el("p", {}, offeringPrice(node)),
    el("p", {}, `Billing interval: ${typeof interval === "string" && interval ? interval : "Not specified"}`),
    typeof node.properties.pricing_notes === "string" ? el("p", {}, node.properties.pricing_notes) : null,
    rates.length ? el("div", {}, el("h3", {}, "Role rates"), el("ul", {}, ...rates.map(({ role, rate }) => el("li", {}, link(role.title, role.id), ` · ${rate}`)))) : null);
}
function organizationDecisions(g: Graph, organization: GraphNode) {
  const decisions = linkedNodes(g, organization.id, core.scopedTo, true)
    .filter((candidate) => candidate.typeId === core.decisionRecord)
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    .slice(0, 5);
  if (!decisions.length) return null;
  return el("section", { class: "graph-section" }, el("h2", {}, "Recent decisions"),
    el("ul", { class: "wiki-cards" }, ...decisions.map((decision) => {
      const makers = linkedNodes(g, decision.id, core.madeBy);
      const roles = linkedNodes(g, decision.id, core.underAssignment).flatMap((assignment) => linkedNodes(g, assignment.id, core.assignsRole));
      return el("li", { class: "wiki-card" }, link(decision.title, decision.id),
        el("small", {}, ...makers.flatMap((maker, index) => [index ? ", " : "", link(maker.title, maker.id)]),
          ...roles.flatMap((role, index) => [index ? ", " : " · ", link(role.title, role.id)])),
        decision.summary ? el("p", {}, decision.summary) : null);
    })));
}
function entityRelationships(content: HTMLElement, g: Graph, node: GraphNode) {
    for (const [title, type, incoming] of [
      ["Decision type", core.decisionTypeOf, false],
      ["Decision records", core.decisionTypeOf, true],
      ["Made by", core.madeBy, false],
      ["Decisions made", core.madeBy, true],
      ["Acting under role assignment", core.underAssignment, false],
      ["Decisions under this assignment", core.underAssignment, true],
      ["Goals established", core.establishes, false],
      ["Established by decision", core.establishes, true],
      ["Products", core.produces, false],
      ["Produced by", core.produces, true],
      ["Packaged product", core.packagesProduct, false],
      ["Available offerings", core.packagesProduct, true],
      ["Provider", core.offeredBy, false],
      ["Offerings", core.offeredBy, true],
      ["Pays for", core.paysFor, false],
      ["Paying customers", core.paysFor, true],
      ["Offerings priced by this role", core.pricedByRole, true],
      ["Authority grants", core.hasAuthorityGrant, false],
      ["Granted to roles", core.hasAuthorityGrant, true],
      ["Authority definition", core.definedBy, false],
      ["Grants", core.definedBy, true],
      ["Permitted decisions", core.permits, false],
      ["Permitted by", core.permits, true],
      ["Uses", core.uses, false],
      ["Used by", core.uses, true],
      ["Developed by", core.developed, false],
      ["Technologies", core.developed, true],
      ["Integrates with", core.integrates, false],
      ["Integrated with", core.integrates, true],
      ["Customers", core.customerOf, true],
      ["Customer of", core.customerOf, false],
      ["Customer segments", core.inSegment, false],
      ["Customers in this segment", core.inSegment, true],
      ["Customer problems", core.experiences, false],
      ["Experienced by", core.experiences, true],
      ["Problems addressed", core.addresses, false],
      ["Addressed by", core.addresses, true],
    ] as const) {
      if (node.typeId === core.organization && ((type === core.offeredBy && incoming) || (type === core.produces && !incoming))) continue;
      if (node.typeId === core.project && type === core.uses && !incoming) continue;
      if (g.edges.some((edge) => !edge.archived && edge.typeId === type && (incoming ? edge.toId : edge.fromId) === node.id))
        content.appendChild(projectSection(g, node, title, type, incoming));
    }
}
function entitySections(root: HTMLElement, content: HTMLElement, g: Graph, node: GraphNode) {
    if (node.typeId === core.organization) {
      const decisions = organizationDecisions(g, node);
      if (decisions) content.appendChild(decisions);
      content.appendChild(organizationProducts(g, node));
      content.appendChild(organizationOfferings(g, node));
    }
    if (node.typeId === core.offering) content.appendChild(offeringPricing(g, node));
    if (node.typeId === core.decisionRecord)
      content.appendChild(projectSection(g, node, "Decision scope", core.scopedTo));
    const assignments = roleAssignments(g, node);
    if (assignments) content.appendChild(assignments);
    entityRelationships(content, g, node);
    if (node.typeId === core.problem)
      content.appendChild(el("section", { class: "graph-section" }, el("h2", {}, "Success measures"), measurementSummary(g, node)));
    if (node.typeId === core.customerSegment)
      content.appendChild(projectSection(g, node, "Goals", core.pursues));
    if (node.typeId === core.organization) {
      content.appendChild(organizationGoals(g, node));
      content.appendChild(organizationProjectList(g, node));
    }
    if (node.typeId !== core.project) return;
    content.appendChild(projectRepositories(root, g, node));
    for (const [title, type, incoming] of [
      ["Business unit", core.belongs, false],
      ["Participants", core.participates, true],
      ["Dependencies", core.uses, false],
      ["Goals", core.pursues, false],
    ] as const)
      content.appendChild(projectSection(g, node, title, type, incoming));
    if (g.canEdit)
      content.appendChild(
        el(
          "nav",
          { class: "graph-actions" },
          ...[
            ["unit", "Set business unit"],
            ["participant", "Add participant"],
            ["dependency", "Add dependency"],
            ["goal", "Add goal"],
          ].map(([action, title]) =>
            button(title, () => addConnection(root, g, node, action)),
          ),
        ),
      );
}
function entityDocumentation(g: Graph, node: GraphNode) {
  const type = g.types.find(type => type.id === node.typeId);
  if (type?.ontology?.version === 2 && type.ontology.stereotype === "assertion") return assertionReview(g, node);
  const prose = el("div", { class: "documentation" });
  const body = structuredBodyMarkdown(node.body, bodySchema(g, node)) ?? node.body;
  prose.innerHTML = micromark(body || "No documentation yet.", { allowDangerousHtml: false, allowDangerousProtocol: false });
  return prose;
}
function bodySchema(g: Graph, node: GraphNode) {
  if (node.typeId === core.knowledgeGraph && node.body.trim().startsWith("{")) return contextGraphSchema;
  return g.types.find(type => type.id === node.typeId)?.jsonSchema;
}
/** The graphs view describes itself in more detail. */
function describeEntity(g: Graph, node: GraphNode, view: string) {
  if (view === "graphs") return;
  agentPage("wiki-map").describe({ title: node.title, summary: `The ${view} view of this entity.`,
    state: { entity: { id: node.id, title: node.title, type: registryName(g, node.typeId) }, view } });
}
// Tabs sit on the title row, right of the name, so the view starts higher.
function placeViewTabs(root: HTMLElement, identity: HTMLElement, g: Graph, node: GraphNode, view: string, href: string) {
  const tabs = el("nav", { class: "wiki-view-tabs", "aria-label": "Entity views" },
    ...[["Overview", href, "overview"], ["Connections", `${href}/connections`, "connections"],
      ["Knowledge graphs", `${href}/knowledge-graphs`, "graphs"], ...orgChartLinks(g, node, href)].map(([label, url, key]) =>
        el("a", { href: url, ...(view === key ? { "aria-current": "page" } : {}) }, label)),
  );
  const titleRow = identity.querySelector(".node-title-row");
  if (titleRow) titleRow.insertBefore(tabs, titleRow.querySelector("button"));
  else root.appendChild(tabs);
}
function entityPage(root: HTMLElement, g: Graph, node: GraphNode) {
  root.replaceChildren();
  const identity = nodeIdentity(g, node, () => documentation(root, node));
  const intro = root.closest(".ui-content")?.querySelector(".intro");
  if (intro) intro.replaceChildren(identity);
  else root.appendChild(identity);
  document.title = `${node.title} — Wiki`;
  const view = params.get("tab") ?? root.dataset.view ?? "overview";
  describeEntity(g, node, view);
  const href = entityUrl(node.id);
  // Existing bookmarks become canonical routes without adding a history entry.
  if (params.has("tab")) {
    location.replace(`${href}${view === "graphs" ? "/knowledge-graphs" : view === "connections" ? "/connections" : ""}`);
    return;
  }
  root.closest(".ui-content")?.classList.toggle("wiki-graph-content", view === "graphs" || view === "org-chart");
  if (view !== "overview") placeViewTabs(root, identity, g, node, view, href);
  const content = el("div", { class: "wiki-map" });
  root.appendChild(content);
  if (view === "org-chart") {
    content.appendChild(orgChartView(g, node));
    return;
  }
  if (view === "graphs") {
    content.appendChild(knowledgeGraphViews(g, node, root.dataset.graphId, parseGraphQuery(params)));
    return;
  }
  if (view === "connections") {
    content.appendChild(connections(g, node));
    return;
  }
  if (node.typeId === core.knowledgeGraph) {
    // People open a knowledge graph to explore it, so its instances lead and the definition waits behind a disclosure.
    const { instances, definition } = knowledgeGraphOverview(g, node, nodeDetails(g, node, () => entityDocumentation(g, node)));
    content.appendChild(instances);
    content.appendChild(definition);
    entitySections(root, definition, g, node);
    return;
  }
  content.appendChild(nodeDetails(g, node, () => entityDocumentation(g, node), { showRelationships: node.typeId !== core.project }));
  entitySections(root, content, g, node);
}
export function typeAdministration(root: HTMLElement, g: Graph) {
  const list = el("div", { class: "graph-fields" });
  const edit = (current?: TypeDefinition) => {
    const name = input(current?.name),
      title = input(current?.title),
      body = area(current?.body),
      properties = area(JSON.stringify(current?.properties ?? [], null, 2));
    const category = el(
      "select",
      {},
      option("node", "Entity"),
      option("edge", "Connection"),
    );
    category.value = current?.category ?? "node";
    name.required = true;
    title.required = true;
    form(
      root,
      current ? `Edit type: ${current.title}` : "Add type",
      [
        label("Name", name),
        label("Display name", title),
        label("Category", category),
        label("Description", body),
        label("Property definitions (JSON)", properties),
      ],
      async () => {
        await call(`graph/${current ? "update" : "create"}`, {
          type: "graph-type",
          attributes: {
            name: name.value,
            title: title.value,
            category: category.value,
            body: body.value,
            properties: JSON.parse(properties.value),
          },
          ...(current ? { id: current.id, revision: current.revision } : {}),
        });
        location.reload();
      },
    );
  };
  for (const type of g.types.filter((t) => !t.archived))
    list.appendChild(
      el(
        "div",
        {},
        el("strong", {}, type.title),
        el("p", {}, type.body),
        ...(g.canEdit ? [button("Edit", () => edit(type))] : []),
      ),
    );
  root.replaceChildren(list);
  if (g.canEdit) root.appendChild(button("Add type", () => edit()));
}
function matchesRoute(g: Graph, node: GraphNode | undefined, routeType: string | undefined) {
  const type = node && g.types.find((type) => type.id === node.typeId);
  return type && typeSegment(type.name) === routeType;
}
function contextCatalog(target: HTMLElement, graph: Graph) {
  target.replaceChildren(
    knowledgeGraphTable(graph, active(graph).filter(node => node.typeId === core.knowledgeGraph)),
    el("nav", { class: "graph-actions", "aria-label": "Browse Wiki" },
      el("a", { href: appUrl("graph") }, "Open graph explorer"),
      el("a", { href: appUrl("organizations") }, "Browse organizations")),
  );
}

function organizationHome(target: HTMLElement, g: Graph) {
  const organization = active(g).find(node => node.id === g.home?.organizationId && node.typeId === core.organization);
  if (!organization) return home(target, g, g.types.find(type => type.id === core.organization));
  target.dataset.view = "overview";
  entityPage(target, g, organization);
  const charter = active(g).find(node => node.id === g.home?.charterId);
  target.appendChild(el("section", { class: "node-section" }, el("h2", {}, "Organization charter"),
    charter ? link(charter.title, charter.id) : el("p", {}, "No adopted charter is linked yet.")));
  return;
}

const landingViews: Record<string, (target: HTMLElement, graph: Graph) => void> = { home: organizationHome, "context-catalog": contextCatalog };
function renderGraphPage(target: HTMLElement, g: Graph) {
  target.setAttribute("aria-busy", "false");
  const landing = landingViews[String(target.dataset.view)];
  if (landing) return landing(target, g);
  if (!target.dataset.nodeId && location.pathname.replace(/\/$/, "").endsWith("/types"))
    return typesPage(target, g);
  if (target.dataset.nodeType && !target.dataset.nodeId) {
    const collection = g.types.find((t) => t.category === "node" && !t.archived && typeSegment(t.name) === target.dataset.nodeType);
    if (collection) return home(target, g, collection);
    target.replaceChildren(heading("Entity type not found"), el("a", { href: appUrl() }, "Overview"));
    return;
  }
  const type = g.types.find(
    (t) => t.id === (target.dataset.nodeType === "types" ? target.dataset.nodeId : params.get("type")) && !t.archived,
  );
  if (type) return typePage(target, g, type);
  if (params.get("new") === "project" && g.canEdit)
    return projectForm(target);
  if (params.has("new") && g.canEdit)
    return newEntity(target, params.get("new")!);
  const node = g.nodes.find(
    (n) => n.id === (target.dataset.nodeId ?? params.get("node")) || n.slug === params.get("slug"),
  );
  if (target.dataset.nodeId && !matchesRoute(g, node, target.dataset.nodeType)) {
    target.replaceChildren(heading("Entity not found"), el("a", { href: appUrl() }, "Overview"));
    return;
  }
  if (!node) return home(target, g);
  return entityPage(target, g, node);
}
function renderPage() {
  root = document.getElementById("graph");
  params = new URLSearchParams(location.search);
  const target = root;
  if (!target || target.dataset.initialized) return;
  target.dataset.initialized = "true";
  loadGraph()
    .then((g) => {
      if (root !== target || !target.isConnected) return;
      return renderGraphPage(target, g);
    })
    .catch((error) => {
      if (root !== target || !target.isConnected) return;
      target.replaceChildren(
        heading("Unable to load context"),
        el("p", {}, String(error)),
      );
      notice(String(error));
    });

}
document.addEventListener("astro:page-load", renderPage);
renderPage();
