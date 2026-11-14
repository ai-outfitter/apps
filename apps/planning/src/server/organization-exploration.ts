import { z } from "zod";
import type { EntityRecord, EntityRef } from "@ai-outfitter/app-sdk/entities";
import {
  requireOrganization,
  type AppIdentity,
} from "@ai-outfitter/app-sdk/server";
import type { readWikiGraph } from "@ai-outfitter/app-sdk/graph-client";
import {
  assessProjectReadiness,
  type ProjectReadiness,
} from "../project-readiness";

export const organizationExplorationInput = z.strictObject({
  nodeId: z.uuid().optional(),
  definitionId: z.uuid().optional(),
  branch: z
    .enum(["overview", "products", "customers", "projects", "goals", "gaps"])
    .default("overview"),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(50).default(20),
});
type Input = z.input<typeof organizationExplorationInput>;
type Graph = Pick<
  Awaited<ReturnType<typeof readWikiGraph>>,
  "nodes" | "edges" | "types"
>;
export type OrganizationRecord = {
  ref: EntityRef;
  revision: number;
  title: string;
  type: string;
  summary: string;
  references: EntityRef[];
  related: {
    ref: EntityRef;
    revision: number;
    title: string;
    type: string;
    relation: string;
    direction: "incoming" | "outgoing";
  }[];
  readiness?: ProjectReadiness;
  relatedTotal: number;
  relatedTruncated: boolean;
  latestObservation?: {
    ref: EntityRef;
    revision: number;
    capturedAt: string;
    value: unknown;
    source: string | null;
    freshness: "recorded-age-unknown";
    ageSeconds: number | null;
  } | null;
};
export type OrganizationGap = {
  code: string;
  message: string;
  subject?: EntityRef;
  requiredNodeType?: { ref: EntityRef; revision: number; name: string };
  requiredEdgeType?: { ref: EntityRef; revision: number; name: string };
  direction?: string;
};
export type OrganizationExploration = {
  organization: { ref: EntityRef; revision: number; title: string } | null;
  organizationChoices: {
    ref: EntityRef;
    revision: number;
    title: string;
  }[];
  organizationChoicesTotal: number;
  organizationChoicesTruncated: boolean;
  anchorStatus: "resolved" | "missing" | "ambiguous" | "explicit";
  wiki?: { installationId: string; hostname: string | null; slug: string; writable: boolean };
  definition: { ref: EntityRef; revision: number; title: string } | null;
  branch: z.infer<typeof organizationExplorationInput>["branch"];
  branches: {
    id: "products" | "customers" | "projects" | "goals" | "gaps";
    title: string;
    count: number;
  }[];
  records: OrganizationRecord[];
  gaps: OrganizationGap[];
  nextOffset: number | null;
  freshness: {
    readAt: string;
    graphSnapshot: "request-read";
    observations: string;
  };
  ownership: {
    planningInstallationId: string;
    organizationId: string;
    note: string;
  };
};
const active = (r: EntityRecord) =>
  !r.attributes.archived && !r.attributes.archivedAt;
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
function body(r: EntityRecord) {
  try {
    return object(JSON.parse(String(r.attributes.body ?? "{}")));
  } catch {
    return {};
  }
}
const compare = (a: EntityRecord, b: EntityRecord) =>
  a.ref.id < b.ref.id ? -1 : a.ref.id > b.ref.id ? 1 : 0;
function bounded<T>(value: T): T {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 500 * 1024)
    throw new Response(
      "Organization exploration exceeds 500 KiB; narrow the branch/limit",
      { status: 413 },
    );
  // Product graphs answer it as JSON, so omit optional undefined members.
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The same validated saved pattern drives filtered reads and in-memory exploration. */
export function resolveOrganizationPattern(
  registry: EntityRecord[],
  anchor: EntityRecord,
  lens: EntityRecord,
) {
  let skippedArchivedRules = 0;
  const properties = object(lens.attributes.properties),
    pattern = z
      .strictObject({
        relationships: z
          .array(
            z.union([
              z.string().trim().min(1).max(120),
              z.record(z.string(), z.unknown()),
            ]),
          )
          .min(1)
          .max(32),
        max_depth: z.number().int().min(1).max(10),
      })
      .parse(JSON.parse(String(properties.pattern ?? "")));
  const resolveType = (reference: string, category: "node" | "edge") => {
    const matches = registry.filter(
      (t) =>
        t.attributes.category === category &&
        (t.ref.id === reference || t.attributes.name === reference),
    );
    const activeMatches = matches.filter(active);
    if (activeMatches.length === 1) return activeMatches[0];
    if (activeMatches.length === 0 && matches.length === 1) return matches[0];
    throw new Error(`Unknown/ambiguous ${category} type in definition`);
  };
  const root = resolveType(String(properties.root_type ?? "").trim(), "node");
  if (
    !active(root) ||
    root.attributes.name !== "Organization" ||
    root.ref.id !== anchor.attributes.typeId
  )
    throw new Error(
      "Definition root_type must resolve to an active Organization",
    );
  const depth = Number(pattern.max_depth);
  if (
    !Number.isInteger(depth) ||
    depth < 1 ||
    depth > 10 ||
    !Array.isArray(pattern.relationships) ||
    pattern.relationships.length < 1 ||
    pattern.relationships.length > 32
  )
    throw new Error("Invalid bounded definition pattern");
  const rules = pattern.relationships.flatMap((raw) => {
    const rule =
      typeof raw === "string"
        ? { type: raw, direction: "outgoing" }
        : z
            .strictObject({
              type: z.string().trim().min(1).max(120),
              direction: z.enum(["incoming", "outgoing"]).default("outgoing"),
              from_type: z.string().trim().min(1).max(120).optional(),
              to_type: z.string().trim().min(1).max(120).optional(),
            })
            .parse(raw);
    const edgeType = resolveType(rule.type, "edge");
    const fromType =
      "from_type" in rule && rule.from_type
        ? resolveType(rule.from_type, "node")
        : undefined;
    const toType =
      "to_type" in rule && rule.to_type
        ? resolveType(rule.to_type, "node")
        : undefined;
    if (
      !active(edgeType) ||
      (fromType && !active(fromType)) ||
      (toType && !active(toType))
    ) {
      skippedArchivedRules++;
      return [];
    }
    return [
      {
        typeId: edgeType.ref.id,
        direction: rule.direction ?? "outgoing",
        fromType: fromType?.ref.id,
        toType: toType?.ref.id,
      },
    ];
  });
  return { depth, rules, skippedArchivedRules };
}

/** A saved Wiki lens determines selection. The authenticated owner determines access, never this graph. */
export function exploreOrganizationGraph(
  graph: Graph,
  identity: AppIdentity,
  input: Input,
  projects: EntityRecord[] = [],
  now = new Date(),
  options: {
    includeReadiness?: boolean;
    sourceTruncated?: boolean;
    collectSelected?: (nodes: EntityRecord[]) => void;
    recordTypes?: readonly string[];
  } = {},
): OrganizationExploration {
  const who = requireOrganization(identity),
    value = organizationExplorationInput.parse(input);
  const registry = graph.types;
  const types = new Map(registry.filter(active).map((r) => [r.ref.id, r]));
  const name = (r: EntityRecord) =>
    String(
      registry.find((t) => t.ref.id === r.attributes.typeId)?.attributes.name ??
        "",
    );
  const nodes = graph.nodes.filter(
      (r) =>
        active(r) &&
        body(r).status !== "retired" &&
        (types.has(String(r.attributes.typeId)) || name(r) === "Organization"),
    ),
    edges = graph.edges.filter(
      (edge) => active(edge) && types.has(String(edge.attributes.typeId)),
    ),
    byId = new Map(nodes.map((r) => [r.ref.id, r]));
  const organizations = nodes.filter((r) => name(r) === "Organization");
  const anchors = value.nodeId
    ? organizations.filter((r) => r.ref.id === value.nodeId)
    : organizations.filter(
        (r) =>
          object(r.attributes.properties).organization_id ===
          who.organizationId,
      );
  if (value.nodeId && anchors.length !== 1)
    throw new Response("Organization node is not active in this scoped Wiki", {
      status: 404,
    });
  const anchor = anchors.length === 1 ? anchors[0] : null;
  const gaps: OrganizationGap[] = [];
  const hint = (type: string) => {
    const t = [...types.values()].find((t) => t.attributes.name === type);
    return t ? { ref: t.ref, revision: t.revision, name: type } : undefined;
  };
  if (!anchor)
    gaps.push({
      code: anchors.length
        ? "ambiguous-organization"
        : "missing-organization-binding",
      message: anchors.length
        ? "Multiple Wiki Organization nodes reference the authenticated organization. Resolve canonical binding or explicitly select nodeId."
        : "No Wiki Organization has properties.organization_id matching the authenticated organization. Set Organization.properties.organization_id to the exact authenticated organization ID using the current Wiki node revision, or explicitly inspect an Organization nodeId in this same Wiki. A title or graph relationship cannot select or authorize an organization.",
      requiredNodeType: hint("Organization"),
    });
  const lenses = nodes.filter(
    (n) =>
      name(n) === "KnowledgeGraph" &&
      (value.definitionId
        ? n.ref.id === value.definitionId
        : n.attributes.slug === "organization-overview"),
  );
  const lens = lenses.length === 1 ? lenses[0] : null;
  if (!lens)
    gaps.push({
      code: lenses.length
        ? "ambiguous-overview-definition"
        : "missing-overview-definition",
      message:
        "Install or select the Wiki standard Organization overview KnowledgeGraph definition; Planning does not invent a private graph traversal.",
      requiredNodeType: hint("KnowledgeGraph"),
    });
  const selected = new Map<string, EntityRecord>();
  let definitionValid = false;
  let traversalTruncated = options.sourceTruncated ?? false;
  let skippedArchivedRules = 0;
  function matchingTarget(
    currentId: string,
    rule: ReturnType<typeof resolveOrganizationPattern>["rules"][number],
    edge: EntityRecord,
  ) {
    if (edge.attributes.typeId !== rule.typeId) return;
    const storedFrom = byId.get(String(edge.attributes.fromId));
    const storedTo = byId.get(String(edge.attributes.toId));
    const matchesFrom =
      !rule.fromType || storedFrom?.attributes.typeId === rule.fromType;
    const matchesTo =
      !rule.toType || storedTo?.attributes.typeId === rule.toType;
    if (!matchesFrom || !matchesTo) return;
    const source = rule.direction === "incoming" ? storedTo : storedFrom;
    if (source?.ref.id !== currentId) return;
    return rule.direction === "incoming" ? storedFrom : storedTo;
  }
  function collectLensNodes(
    anchor: EntityRecord,
    depth: number,
    rules: ReturnType<typeof resolveOrganizationPattern>["rules"],
  ) {
    const queue = [{ node: anchor, depth: 0 }];
    function followRule(
      current: (typeof queue)[number],
      rule: (typeof rules)[number],
      edge: EntityRecord,
    ) {
      const target = matchingTarget(current.node.ref.id, rule, edge);
      if (!target) return;
      if (selected.has(target.ref.id)) return;
      if (selected.size >= 200) {
        traversalTruncated = true;
        return;
      }
      selected.set(target.ref.id, target);
      queue.push({ node: target, depth: current.depth + 1 });
    }
    for (let i = 0; i < queue.length; i++) {
      const current = queue[i];
      if (current.depth >= depth) continue;
      for (const rule of rules)
        for (const edge of edges) followRule(current, rule, edge);
    }
  }
  function initializeSelection() {
    if (anchor && lens) {
      try {
        const resolved = resolveOrganizationPattern(registry, anchor, lens);
        const { depth, rules } = resolved;
        skippedArchivedRules = resolved.skippedArchivedRules;
        selected.set(anchor.ref.id, anchor);
        collectLensNodes(anchor, depth, rules);
        definitionValid = true;
      } catch (error) {
        if (error instanceof Response) throw error;
        selected.clear();
        gaps.push({
          code: "invalid-overview-definition",
          message:
            error instanceof Error
              ? error.message
              : "Invalid Organization overview definition",
          subject: lens.ref,
        });
      }
    }
  }
  function reportSelectionBounds() {
    if (definitionValid && skippedArchivedRules)
      gaps.push({
        code: "archived-overview-paths",
        message:
          "Some relationships in this saved view use archived definitions and were excluded. The remaining context is shown; excluded paths do not establish missing records.",
        subject: lens?.ref,
      });
    if (traversalTruncated)
      gaps.push({
        code: "truncated-overview",
        message:
          "The shared Organization overview lens reached its 200-node bound. Counts and branches describe the selected subset; narrow the saved definition or inspect specific Wiki records for remaining context.",
        subject: lens?.ref,
      });
  }
  initializeSelection();
  reportSelectionBounds();
  const scope = [...selected.values()]
    .filter((r) => r.ref.id !== anchor?.ref.id)
    .sort(compare);
  options.collectSelected?.(scope);
  const related = (r: EntityRecord): OrganizationRecord["related"] =>
    edges.flatMap((edge) => {
      const outgoing = edge.attributes.fromId === r.ref.id,
        incoming = edge.attributes.toId === r.ref.id;
      if (!outgoing && !incoming) return [];
      const other = selected.get(
        String(outgoing ? edge.attributes.toId : edge.attributes.fromId),
      );
      return other
        ? [
            {
              ref: other.ref,
              revision: other.revision,
              title: other.title,
              type: name(other),
              relation: name(edge),
              direction: outgoing
                ? ("outgoing" as const)
                : ("incoming" as const),
            },
          ]
        : [];
    });
  const projectsById = new Map(
    projects.map((project) => [project.ref.id, project]),
  );
  const linkedProject = (node: EntityRecord) => {
    for (const ref of node.references)
      if (ref.installationId === who.installationId && ref.type === "project") {
        const project = projectsById.get(ref.id);
        if (project) return project;
      }
    return undefined;
  };
  const records = (rows: EntityRecord[]) =>
    rows.map((r): OrganizationRecord => {
      const relations = related(r);
      const result: OrganizationRecord = {
        ref: r.ref,
        revision: r.revision,
        title: r.title,
        type: name(r),
        summary: String(r.attributes.summary ?? "").slice(0, 280),
        references: r.references,
        related: relations.slice(0, 20),
        relatedTotal: relations.length,
        relatedTruncated: relations.length > 20,
      };
      const project = linkedProject(r);
      if (name(r) === "Project" && project)
        result.readiness = readinessByProject.get(project.ref.id);
      if (name(r) === "MetricDefinition") result.latestObservation = null;
      return result;
    });
  const grouped = {
    products: scope.filter((r) =>
      ["Product", "SoftwareProduct", "Offering"].includes(name(r)),
    ),
    customers: scope.filter((r) =>
      ["CustomerSegment", "Problem"].includes(name(r)),
    ),
    projects: scope.filter((r) => name(r) === "Project"),
    goals: scope.filter((r) => ["Goal", "MetricDefinition"].includes(name(r))),
  };
  const readinessByProject = new Map<string, ProjectReadiness>();
  function assessLinkedProjects() {
    for (const node of options.includeReadiness === false
      ? []
      : grouped.projects) {
      const project = linkedProject(node);
      if (project && !readinessByProject.has(project.ref.id))
        readinessByProject.set(
          project.ref.id,
          assessProjectReadiness(graph, who.installationId, project.ref.id),
        );
    }
  }
  assessLinkedProjects();
  const linkedReadiness = (node: EntityRecord) => {
    const project = linkedProject(node);
    return project ? readinessByProject.get(project.ref.id) : undefined;
  };
  const stages = { implement: 0, plan: 1, frame: 2 };
  grouped.projects.sort((a, b) => {
    const left = linkedReadiness(a),
      right = linkedReadiness(b);
    return (
      (left ? stages[left.stage] : 3) - (right ? stages[right.stage] : 3) ||
      (right?.priority ?? 0) - (left?.priority ?? 0) ||
      compare(a, b)
    );
  });
  function collectProjectGaps() {
    for (const project of grouped.projects)
      if (!linkedProject(project))
        gaps.push({
          code: "unlinked-planning-project",
          message:
            "Wiki Project has no matching canonical project in this Planning installation. Preserve its source identity; inspect its owning Planning installation rather than recreate it by title.",
          subject: project.ref,
        });
    if (
      anchor &&
      definitionValid &&
      !traversalTruncated &&
      !skippedArchivedRules &&
      object(anchor.attributes.properties).organization_id ===
        who.organizationId
    ) {
      const reached = new Set(
        grouped.projects.map((node) => linkedProject(node)?.ref.id),
      );
      for (const project of projects)
        if (!reached.has(project.ref.id))
          gaps.push({
            code: "project-outside-overview",
            message: `Planning project “${project.title}” is not connected to this organization overview. Link its canonical Wiki Project to this Organization with part_of, or inspect the saved view definition.`,
            subject: project.ref,
            requiredNodeType: hint("Project"),
            requiredEdgeType: hint("part_of"),
            direction: "Project → Organization",
          });
    }
  }
  collectProjectGaps();
  const branchRepair = {
    products: {
      node: "Offering",
      edge: "offered_by",
      direction: "Offering → Organization",
      message:
        "Reuse or create an Offering, link offered_by to this Organization, then packages_product from that Offering to its Product. Preserve both node identities; an offering is not a product.",
    },
    customers: {
      node: "Problem",
      edge: "addresses",
      direction: "Organization → Problem",
      message:
        "Link this Organization or one of its scoped Products/Projects to its Problem with addresses. Link the actual CustomerSegment → experiences → that Problem; proposed relationships remain hypotheses.",
    },
    projects: {
      node: "Project",
      edge: "part_of",
      direction: "Project → Organization",
      message:
        "Link a canonical Planning project through its sourced Wiki Project, then Project → part_of → this Organization; create the Planning record first if it does not exist.",
    },
    goals: {
      node: "Goal",
      edge: "pursues",
      direction: "Organization → Goal",
      message:
        "Reuse or create a Goal and link Organization → pursues → Goal; connect Goal → measured_by → MetricDefinition. A definition or target is not an observation.",
    },
  };
  function collectBranchGaps() {
    for (const [branch, rows] of Object.entries(grouped))
      if (
        anchor &&
        definitionValid &&
        !traversalTruncated &&
        !skippedArchivedRules &&
        !rows.length
      ) {
        const repair = branchRepair[branch as keyof typeof branchRepair];
        gaps.push({
          code: `missing-${branch}`,
          message: repair.message,
          subject: anchor.ref,
          requiredNodeType: hint(repair.node),
          requiredEdgeType: hint(repair.edge),
          direction: repair.direction,
        });
      }
    for (const metric of grouped.goals.filter(
      (r) => name(r) === "MetricDefinition",
    ))
      gaps.push({
        code: "missing-measurement-observation",
        message: `Measurement “${metric.title}” has no supported structured observation contract. Its description or target is not a measured current value; record a dated observation with source and reporting period before claiming progress.`,
        subject: metric.ref,
      });
  }
  collectBranchGaps();
  function organizationAnchorStatus(): OrganizationExploration["anchorStatus"] {
    if (anchor) return value.nodeId ? "explicit" : "resolved";
    return anchors.length ? "ambiguous" : "missing";
  }
  function renderExploration(): OrganizationExploration {
    function branchRows() {
      return value.branch === "overview"
        ? [
            ...grouped.products.slice(0, Math.min(5, value.limit)),
            ...grouped.customers.slice(0, Math.min(5, value.limit)),
            ...grouped.projects.slice(0, Math.min(5, value.limit)),
            ...grouped.goals.slice(0, Math.min(5, value.limit)),
          ]
        : value.branch === "gaps"
          ? []
          : grouped[value.branch];
    }
    const selectedRows = options.recordTypes ? branchRows().filter(row => options.recordTypes!.includes(name(row))) : branchRows();
    function nextBranchOffset() {
      return value.branch !== "overview" &&
        value.offset + value.limit <
          (value.branch === "gaps" ? gaps.length : selectedRows.length)
        ? value.offset + value.limit
        : null;
    }
    const page = records(
      value.branch === "overview"
        ? selectedRows
        : selectedRows.slice(value.offset, value.offset + value.limit),
    );
    const branches: OrganizationExploration["branches"] = [
      {
        id: "products",
        title: "Product Explorer",
        count: grouped.products.length,
      },
      {
        id: "customers",
        title: "Customer segments and problems",
        count: grouped.customers.length,
      },
      {
        id: "projects",
        title: "Projects",
        count: grouped.projects.length,
      },
      {
        id: "goals",
        title: "Goals and measurements",
        count: grouped.goals.length,
      },
      {
        id: "gaps",
        title: "Planning gaps",
        count: gaps.length,
      },
    ];
    return bounded({
      organizationChoicesTotal: organizations.length,
      organizationChoicesTruncated: organizations.length > 50,
      organizationChoices: organizations
        .sort(compare)
        .slice(0, 50)
        .map((n) => ({ ref: n.ref, revision: n.revision, title: n.title })),
      organization: anchor
        ? { ref: anchor.ref, revision: anchor.revision, title: anchor.title }
        : null,
      anchorStatus: organizationAnchorStatus(),
      definition: lens
        ? { ref: lens.ref, revision: lens.revision, title: lens.title }
        : null,
      branch: value.branch,
      branches,
      records: page,
      gaps: gaps.slice(
        value.branch === "gaps" ? value.offset : 0,
        value.branch === "gaps" ? value.offset + value.limit : 10,
      ),
      nextOffset: nextBranchOffset(),
      freshness: {
        readAt: now.toISOString(),
        graphSnapshot: "request-read",
        observations:
          "Metric definitions are not observations. Missing typed evidence stays explicit; a fresh graph read does not make evidence fresh.",
      },
      ownership: {
        planningInstallationId: who.installationId,
        organizationId: who.organizationId,
        note: "Authenticated organization scopes SDK Wiki reads. Explicit node selection changes the subject only, never access or authority. Wiki owns ontology/context; Planning owns canonical projects and advisory readiness.",
      },
    });
  }
  return renderExploration();
}
