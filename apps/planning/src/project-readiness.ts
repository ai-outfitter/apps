import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";
import { githubRepositoryName } from "@ai-outfitter/app-sdk/github-pulls";

export const readinessStages = [
  {
    id: "implement",
    title: "Ready to implement",
    description:
      "Framed need, linked organizational outcome, approved requirements and observable criteria for the work.",
  },
  {
    id: "plan",
    title: "Ready to plan",
    description:
      "The people or roles involved and their problem are identifiable. Fill in the scope, requirements and criteria next.",
  },
  {
    id: "frame",
    title: "Needs framing",
    description:
      "Start with who needs something, the problem they face and the desired outcome.",
  },
] as const;
export type ReadinessStage = (typeof readinessStages)[number]["id"];
export type ProjectReadiness = {
  projectId: string;
  stage: ReadinessStage;
  priority: number;
  signals: string[];
  missing: string[];
  priorityGaps: string[];
  evidence: { id: string; type: string; title: string }[];
};
type Graph = {
  nodes: EntityRecord[];
  edges: EntityRecord[];
  types: EntityRecord[];
};
function body(node: EntityRecord): Record<string, unknown> {
  try {
    const value = JSON.parse(String(node.attributes.body ?? "{}"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  } catch {
    return {};
  }
}
const written = (value: unknown) => typeof value === "string" && !!value.trim();
const active = (n: EntityRecord) =>
  !n.attributes.archived &&
  !n.attributes.archivedAt &&
  body(n).status !== "retired" &&
  (n.attributes.properties as { status?: unknown } | undefined)?.status !==
    "retired";
const productTypes = ["Product", "SoftwareProduct"];
const scopeRelations = new Set([
  "has_use_case",
  "has_story",
  "has_requirement",
  "has_acceptance_criterion",
  "addresses",
  "pursues",
  "experiences",
  "produces",
  "part_of",
  "measured_by",
]);
const contextTypes = new Set([
  "Problem",
  "Goal",
  "MetricDefinition",
  "CustomerSegment",
  "UserStory",
  "UseCase",
  "Requirement",
  "AcceptanceCriterion",
  ...productTypes,
]);
const terminalTypes = new Set([
  ...productTypes,
  "Goal",
  "MetricDefinition",
  "CustomerSegment",
  "Problem",
]);
function query(graph: Graph) {
  const types = new Map(
    graph.types
      .filter(active)
      .map((t) => [t.ref.id, String(t.attributes.name)]),
  );
  const name = (n: EntityRecord) =>
    types.get(String(n.attributes.typeId)) ?? "";
  const nodes = graph.nodes.filter(active),
    edges = graph.edges.filter(active);
  const byId = new Map(nodes.map((n) => [n.ref.id, n]));
  // Adjacency lists, built once: a hop costs the node's degree, never a scan of every edge.
  const outgoing = new Map<string, EntityRecord[]>();
  const incoming = new Map<string, EntityRecord[]>();
  for (const e of edges) {
    const from = String(e.attributes.fromId), to = String(e.attributes.toId);
    outgoing.set(from, [...(outgoing.get(from) ?? []), e]);
    incoming.set(to, [...(incoming.get(to) ?? []), e]);
  }
  const out = (id: string) => outgoing.get(id) ?? [];
  const into = (id: string) => incoming.get(id) ?? [];
  /** Nodes of `type` with a `relation` edge to any of `targets`, in node order. */
  const linked = (type: string, relation: string, targets: EntityRecord[]) => {
    const found = new Set<string>();
    for (const target of targets)
      for (const e of into(target.ref.id))
        if (name(e) === relation) {
          const source = byId.get(String(e.attributes.fromId));
          if (source && name(source) === type) found.add(source.ref.id);
        }
    return nodes.filter((n) => found.has(n.ref.id));
  };
  return { name, nodes, edges, byId, out, into, linked };
}
type Query = ReturnType<typeof query>;
function contextNeighbours(q: Query, node: EntityRecord, anchor: EntityRecord) {
  return q.out(node.ref.id)
    .filter((e) => scopeRelations.has(q.name(e)))
    .flatMap((edge) => {
      const target = q.byId.get(String(edge.attributes.toId));
      if (!target || !contextTypes.has(q.name(target))) return [];
      // A direct association may describe work on an existing product. Do not
      // traverse organizational part_of links or borrow a tool through uses.
      if (
        q.name(edge) === "part_of" &&
        (node.ref.id !== anchor.ref.id ||
          !productTypes.includes(q.name(target)))
      )
        return [];
      return [target];
    });
}
function projectContext(q: Query, anchor: EntityRecord) {
  const selected = new Map<string, EntityRecord>();
  const queue = [{ node: anchor, depth: 0 }];
  const seen = new Set([anchor.ref.id]);
  for (let index = 0; index < queue.length; index++) {
    const { node, depth } = queue[index];
    if (depth >= 6) continue;
    for (const target of contextNeighbours(q, node, anchor)) {
      if (seen.has(target.ref.id)) continue;
      seen.add(target.ref.id);
      selected.set(target.ref.id, target);
      // Shared context is terminal: never borrow another project's scope.
      if (!terminalTypes.has(q.name(target)))
        queue.push({ node: target, depth: depth + 1 });
    }
  }
  const problems = [...selected.values()].filter(
    (n) => q.name(n) === "Problem",
  );
  for (const user of q.linked("CustomerSegment", "experiences", problems))
    selected.set(user.ref.id, user);
  return [...selected.values()];
}
function coveredRequirements(
  q: Query,
  requirements: EntityRecord[],
  selected: EntityRecord[],
) {
  const criteria = new Set(
    selected
      .filter(
        (n) =>
          q.name(n) === "AcceptanceCriterion" &&
          written(body(n).condition) &&
          written(body(n).expectedOutcome),
      )
      .map((n) => n.ref.id),
  );
  return requirements.filter((n) =>
    q.out(n.ref.id).some((e) => q.name(e) === "has_acceptance_criterion" && criteria.has(String(e.attributes.toId))),
  );
}
function demonstrations(q: Query, products: EntityRecord[]) {
  const revisions = q.linked("ProductRevision", "revision_of", products);
  return q.linked("Demonstration", "demonstrates", revisions).filter((n) => {
    const data = body(n),
      subject = data.subject as { id?: string; revision?: number } | undefined;
    const exactSubject = revisions.some(
      (s) =>
        s.ref.id === subject?.id &&
        s.revision === subject?.revision &&
        q.out(n.ref.id).some((e) => q.name(e) === "demonstrates" && e.attributes.toId === s.ref.id),
    );
    return (
      exactSubject &&
      Array.isArray(data.media) &&
      data.media.some(written) &&
      written(data.environment) &&
      written(data.capturedAt)
    );
  });
}
function missingContext(
  problems: EntityRecord[],
  hasUser: boolean,
  scenario: boolean,
  business: EntityRecord[],
  requirements: EntityRecord[],
  approved: EntityRecord[],
  covered: EntityRecord[],
) {
  const missing: string[] = [];
  if (!problems.length)
    missing.push("Link the problem or need this work addresses.");
  if (!hasUser)
    missing.push(
      "Identify the people or roles involved in a linked story, use case or segment.",
    );
  if (!scenario)
    missing.push(
      "Describe a desired outcome in a linked use case or user story.",
    );
  if (!business.length)
    missing.push("Link an organizational outcome or success measure.");
  if (!requirements.length)
    missing.push("Define the smallest requirements for the work.");
  else if (approved.length !== requirements.length)
    missing.push(
      `Clarify and approve ${requirements.length - approved.length} requirement(s).`,
    );
  if (covered.length !== requirements.length || !requirements.length)
    missing.push(
      "Give each requirement structured acceptance criteria: condition and expected outcome.",
    );
  return missing;
}
function describeProductContext(
  result: ProjectReadiness,
  products: EntityRecord[],
  offerings: EntityRecord[],
  demos: EntityRecord[],
) {
  if (!products.length)
    result.priorityGaps.push(
      "Optional: associate an existing product this project works on, or link a product it creates or maintains.",
    );
  if (!offerings.length)
    result.priorityGaps.push(
      "Optional: connect the associated product to an offering.",
    );
  result.priority = offerings.length ? (demos.length ? 2 : 1) : 0;
  if (offerings.length)
    result.signals.push(
      demos.length
        ? "Product in an offering · demonstration recorded"
        : "Product in an offering · no demonstration recorded",
    );
  else
    result.signals.push(
      "Product / offering context is optional; none established",
    );
}
/** Advisory graph completeness only: never approval, completion or an execution gate. */
export function assessProjectReadiness(
  graph: Graph,
  installationId: string,
  projectId: string,
): ProjectReadiness {
  const q = query(graph);
  const anchors = projectAnchors(q, installationId, projectId);
  const result: ProjectReadiness = {
    projectId,
    stage: "frame",
    priority: 0,
    signals: [],
    missing: [],
    priorityGaps: [],
    evidence: [],
  };
  if (anchors.length !== 1) {
    result.missing = [
      anchors.length
        ? "Resolve the ambiguous project links in Wiki."
        : "Link this project to its Wiki context.",
      "Identify the people or roles involved and their problem.",
    ];
    return result;
  }
  const selected = projectContext(q, anchors[0]);
  const ofType = (...names: string[]) =>
    selected.filter((n) => names.includes(q.name(n)));
  const problems = ofType("Problem"),
    scenarios = ofType("UseCase", "UserStory");
  const hasUser =
    ofType("CustomerSegment").length > 0 ||
    scenarios.some((n) => written(body(n).actor));
  const scenario = scenarios.some(
    (n) =>
      written(body(n).actor) &&
      written(q.name(n) === "UseCase" ? body(n).goal : body(n).capability),
  );
  const business = ofType("Goal", "MetricDefinition"),
    products = ofType(...productTypes);
  const offerings = q.linked("Offering", "packages_product", products),
    demos = demonstrations(q, products);
  const requirements = ofType("Requirement");
  const approved = requirements.filter(
    (n) => body(n).status === "approved" && written(body(n).statement),
  );
  const covered = coveredRequirements(q, requirements, selected);
  result.missing = missingContext(
    problems,
    hasUser,
    scenario,
    business,
    requirements,
    approved,
    covered,
  );
  if (problems.length && hasUser)
    result.stage = result.missing.length ? "plan" : "implement";
  describeProductContext(result, products, offerings, demos);
  if (problems.length)
    result.signals.push(`${problems.length} linked problem(s)`);
  if (requirements.length)
    result.signals.push(
      `${approved.length}/${requirements.length} requirements approved · ${covered.length}/${requirements.length} with criteria`,
    );
  result.evidence = [
    ...new Map(
      [...selected, ...offerings, ...demos].map((n) => [n.ref.id, n]),
    ).values(),
  ].map((n) => ({ id: n.ref.id, type: q.name(n), title: n.title }));
  return result;
}

function projectAnchors(q: Query, installationId: string, projectId: string) {
  return q.nodes.filter(n => q.name(n) === "Project" && n.references.some(r =>
    r.installationId === installationId && r.type === "project" && r.id === projectId));
}

/** Reuse the readiness traversal: shared products/problems are terminal, never other projects' stories. */
export function projectContextRecords(graph: Graph, installationId: string, projectId: string) {
  const q = query(graph);
  const anchors = projectAnchors(q, installationId, projectId);
  if (anchors.length > 1) throw new Response("Multiple Wiki nodes reference this Planning project; resolve the ambiguous links.", {status:409});
  const explicit = q.nodes.filter(node => {
    if (!["UseCase","UserStory"].includes(q.name(node))) return false;
    const properties = node.attributes.properties as Record<string,unknown> | undefined;
    return (properties?.planning_installation_id === installationId && properties.project_id === projectId) ||
      node.references.some(ref=>ref.installationId === installationId && ref.type === "project" && ref.id === projectId);
  });
  const selected = new Map<string,EntityRecord>();
  for (const anchor of [...anchors,...explicit]) {
    if (q.name(anchor) !== "Project") selected.set(anchor.ref.id,anchor);
    for (const node of projectContext(q,anchor)) selected.set(node.ref.id,node);
  }
  const records = (type: string) => [...selected.values()].filter(node=>q.name(node) === type)
    .sort((a,b)=>a.title.localeCompare(b.title)||a.ref.id.localeCompare(b.ref.id))
    .map(node=>({id:node.ref.id,title:node.title,summary:String(node.attributes.summary ?? ""),revision:node.revision}));
  return {useCases:records("UseCase"),customerSegments:records("CustomerSegment"),userStoryRecords:records("UserStory"),goalRecords:records("Goal")};
}

export function projectWikiSlug(graph: Graph, installationId: string, projectId: string): string | null {
  const anchors = projectAnchors(query(graph), installationId, projectId);
  if (anchors.length > 1) throw new Response("Multiple Wiki nodes reference this Planning project; resolve the ambiguous links.", {status:409});
  const slug = anchors[0]?.attributes.slug;
  return typeof slug === "string" && slug ? slug : null;
}

export type ProjectRepository = { nodeId: string; edgeId?: string; title: string; repository: string; url: string; path: string | null; ref: string | null };
/** owner/name from a GitHub repository URL; null for anything else. */
/** The GitHub repositories the project's Wiki node has code in (`source_in`), with each edge's path and ref. */
export function projectRepositories(graph: Graph, installationId: string, projectId: string): ProjectRepository[] {
  const q = query(graph);
  const anchors = projectAnchors(q, installationId, projectId);
  if (anchors.length > 1) throw new Response("Multiple Wiki nodes reference this Planning project; resolve the ambiguous links.", {status:409});
  const anchor = anchors[0];
  if (!anchor) return [];
  return q.out(anchor.ref.id).flatMap((edge) => {
    if (q.name(edge) !== "source_in") return [];
    const target = q.byId.get(String(edge.attributes.toId));
    if (!target || q.name(target) !== "Repository") return [];
    const repository = githubRepositoryName(target.attributes.website);
    if (!repository) return [];
    const properties = (edge.attributes.properties ?? {}) as Record<string, unknown>;
    const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim().replace(/^\/+|\/+$/g, "") : null);
    return [{ nodeId: target.ref.id, edgeId: edge.ref.id, title: target.title, repository, url: String(target.attributes.website), path: text(properties.path), ref: text(properties.ref) }];
  });
}

/** The Wiki Project node that references this Planning project, if exactly one does. */
export function wikiProjectAnchor(graph: Graph, installationId: string, projectId: string): string | null {
  const anchors = projectAnchors(query(graph), installationId, projectId);
  return anchors.length === 1 ? anchors[0].ref.id : null;
}
