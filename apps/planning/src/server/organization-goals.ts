import { graphDatabase, type GraphDatabase } from "./graph-database";
/**
 * The organization's goals and the metrics that measure them, for the projects page
 * and the OrganizationGoals document. The Wiki owns them: the Organization page
 * bound to this installation's organization (its `organization_id` property), the
 * Goals it pursues (the Wiki's read-only `organization-goals` projection) and each
 * goal's `measured_by` metrics. A personal installation has no organization and
 * answers nothing; so does an organization whose Wiki has no bound page.
 */
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";

type Host = WorkflowHost<"interactive">;
export type GoalMetric = { id: string; title: string; summary: string };
export type OrganizationGoal = { id: string; title: string; summary: string; revision: number; metrics: GoalMetric[] };
export type OrganizationGoals = {
  /** The Wiki Organization page's id. */
  id: string;
  revision: number;
  title: string;
  summary: string;
  goals: OrganizationGoal[];
  /** The projection lists at most 20 goals; true when the organization pursues more. */
  truncated: boolean;
};

type Projection = {
  organization: { ref: { id: string }; revision: number; title: string; summary: string };
  goals: { ref: { id: string }; revision: number; title: string; summary: string }[];
  truncated: boolean;
};

/** The one active Organization page bound to `organizationId`; none when missing or ambiguous. */
async function boundOrganization(wiki: GraphDatabase, organizationId: string) {
  const [type] = await wiki.collection("types").list({ where: { name: "Organization", category: "node", archived: false }, select: ["name"], limit: 2 });
  if (!type) return null;
  const bound: string[] = [];
  for (let offset = 0; offset <= 1000; offset += 100) {
    const page = await wiki.collection("nodes").list({ where: { typeId: type.ref.id, archived: false }, select: ["properties"], offset, limit: 100 });
    for (const node of page) {
      const properties = node.attributes.properties as { organization_id?: unknown } | undefined;
      if (properties?.organization_id === organizationId) bound.push(node.ref.id);
    }
    if (page.length < 100) break;
  }
  return bound.length === 1 ? bound[0] : null;
}

/** `measured_by` metrics of these goals, by goal id. */
async function metricsOf(wiki: GraphDatabase, goalIds: string[]) {
  const metrics = new Map<string, GoalMetric[]>(goalIds.map((id) => [id, []]));
  if (!goalIds.length) return metrics;
  const [relation] = await wiki.collection("types").list({ where: { name: "measured_by", category: "edge", archived: false }, select: ["name"], limit: 2 });
  if (!relation) return metrics;
  const edges = await wiki.collection("edges").list({ where: { typeId: relation.ref.id, nodeIds: goalIds.slice(0, 30), archived: false }, select: ["fromId", "toId"], limit: 100 });
  const targets = [...new Set(edges.map((edge) => String(edge.attributes.toId)))];
  const nodes = targets.length
    ? await wiki.collection("nodes").list({ where: { ids: targets.slice(0, 100), archived: false }, select: ["title", "summary"], limit: 100 })
    : [];
  const byId = new Map(nodes.map((node) => [node.ref.id, { id: node.ref.id, title: node.title, summary: String(node.attributes.summary ?? "") }]));
  for (const edge of edges) {
    const metric = byId.get(String(edge.attributes.toId));
    const list = metrics.get(String(edge.attributes.fromId));
    if (metric && list && !list.some((m) => m.id === metric.id)) list.push(metric);
  }
  for (const list of metrics.values()) list.sort((a, b) => a.title.localeCompare(b.title));
  return metrics;
}

export async function readOrganizationGoals(host: Host, identity: { organizationId?: string }): Promise<OrganizationGoals | null> {
  if (!identity.organizationId) return null;
  let wiki: GraphDatabase;
  try {
    wiki = await graphDatabase(host);
  } catch (error) {
    if (error instanceof Response && error.status === 404) return null;
    throw error;
  }
  const organizationNode = await boundOrganization(wiki, identity.organizationId);
  if (!organizationNode) return null;
  const record = await wiki.collection("organization-goals").get(organizationNode);
  const projection = record.attributes as unknown as Projection;
  const metrics = await metricsOf(wiki, projection.goals.map((goal) => goal.ref.id));
  return {
    id: record.ref.id,
    revision: record.revision,
    title: projection.organization.title,
    summary: projection.organization.summary,
    goals: projection.goals.map((goal) => ({ id: goal.ref.id, title: goal.title, summary: goal.summary, revision: goal.revision, metrics: metrics.get(goal.ref.id) ?? [] })),
    truncated: projection.truncated,
  };
}
