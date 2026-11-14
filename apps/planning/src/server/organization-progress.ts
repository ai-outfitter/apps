import { z } from "zod";
import type { appDataContext } from "@ai-outfitter/app-sdk/database";
import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";
import {
  requireOrganization,
  type AppIdentity,
} from "@ai-outfitter/app-sdk/server";
import { metricMeasurements, type MetricReading } from "./measurements";

type Context = ReturnType<typeof appDataContext>;
export type ProgressGraph = {
  wiki: { installationId: string; hostname: string | null; slug: string; writable: boolean };
  types: EntityRecord[];
  nodes: EntityRecord[];
  edges: EntityRecord[];
};
export type OrganizationProgress = {
  kpis: {
    id: string;
    title: string;
    actual: string;
    target: string;
    windowDays: number;
    staged: boolean;
  }[];
  updates: {
    id: string;
    title: string;
    summary: string;
    benefit: string;
    shippedAt: string;
    sourceUrl?: string;
    staged: boolean;
  }[];
};
const active = (record: EntityRecord) =>
  !record.attributes.archived && !record.attributes.archivedAt;
function body(record: EntityRecord): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(String(record.attributes.body ?? ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
function typeId(graph: ProgressGraph, name: string, category: "node" | "edge") {
  const matches = graph.types.filter(
    (record) =>
      active(record) &&
      record.attributes.name === name &&
      record.attributes.category === category,
  );
  return matches.length === 1 ? matches[0].ref.id : undefined;
}
function anchor(graph: ProgressGraph, identity: AppIdentity) {
  const who = requireOrganization(identity);
  const organizationType = typeId(graph, "Organization", "node");
  if (!organizationType) return undefined;
  const matches = graph.nodes.filter(
    (record) =>
      active(record) &&
      record.attributes.typeId === organizationType &&
      (record.attributes.properties as Record<string, unknown> | undefined)
        ?.organization_id === who.organizationId,
  );
  return matches.length === 1 ? matches[0] : undefined;
}
function safeSource(value: unknown) {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function goalDefinition(goal: EntityRecord) {
  const definition = body(goal);
  if (
    definition?.kind !== "planning-goal" ||
    !["users", "USD"].includes(String(definition.unit)) ||
    !(
      definition.target === null ||
      (typeof definition.target === "number" &&
        Number.isFinite(definition.target) &&
        definition.target >= 0)
    ) ||
    !Number.isInteger(definition.windowDays) ||
    Number(definition.windowDays) < 1
  )
    return undefined;
  return definition;
}

function metricKpi(
  id: string,
  metric: EntityRecord,
  definition: Record<string, unknown>,
  latest: MetricReading | null,
) {
  const metricId = metric.ref.id;
  const measurement = body(metric);
  if (
    measurement?.kind !== "planning-kpi" ||
    !["daily-active-users", "inference-sales"].includes(
      String(measurement.metric),
    )
  )
    return undefined;
  if (
    (measurement.metric === "daily-active-users" ? "users" : "USD") !==
    definition.unit
  )
    return undefined;
  const target =
    definition.target === null
      ? "X"
      : new Intl.NumberFormat(
          "en-US",
          definition.unit === "USD"
            ? {
                style: "currency",
                currency: "USD",
                minimumFractionDigits: 0,
                maximumFractionDigits: 2,
              }
            : {},
        ).format(Number(definition.target));
  return {
    id: `${id}:${metricId}`,
    title: metric.title,
    actual: latest
      ? `${new Intl.NumberFormat("en-US").format(latest.value)}${latest.unit ? ` ${latest.unit}` : ""}`
      : "Not connected",
    target: `${target}${definition.unit === "users" ? " users" : ""}`,
    windowDays: Number(definition.windowDays),
    staged: definition.staged === true || measurement.staged === true,
  };
}

function goalKpis(
  graph: ProgressGraph,
  goal: EntityRecord,
  nodes: Map<string, EntityRecord>,
  metricType: string | undefined,
  measuredBy: string | undefined,
  latest: Map<string, MetricReading | null>,
) {
  const id = goal.ref.id;
  const definition = goalDefinition(goal);
  if (!definition) return [];
  const kpis: OrganizationProgress["kpis"] = [];
  const metrics = new Set(
    graph.edges
      .filter(
        (edge) =>
          active(edge) &&
          edge.attributes.typeId === measuredBy &&
          edge.attributes.fromId === id,
      )
      .map((edge) => String(edge.attributes.toId)),
  );
  for (const metricId of metrics) {
    const metric = nodes.get(metricId);
    if (!metric || metric.attributes.typeId !== metricType) continue;
    const kpi = metricKpi(id, metric, definition, latest.get(metricId) ?? null);
    if (kpi) kpis.push(kpi);
  }
  return kpis;
}

function progressKpis(
  graph: ProgressGraph,
  organization: EntityRecord,
): OrganizationProgress["kpis"] {
  const goalType = typeId(graph, "Goal", "node");
  const metricType = typeId(graph, "MetricDefinition", "node");
  const pursues = typeId(graph, "pursues", "edge");
  const measuredBy = typeId(graph, "measured_by", "edge");
  const nodes = new Map(
    graph.nodes.filter(active).map((record) => [record.ref.id, record]),
  );
  const goals = new Set(
    (goalType && metricType && pursues && measuredBy ? graph.edges : [])
      .filter(
        (edge) =>
          active(edge) &&
          edge.attributes.typeId === pursues &&
          edge.attributes.fromId === organization.ref.id,
      )
      .map((edge) => String(edge.attributes.toId)),
  );
  const kpis: OrganizationProgress["kpis"] = [];
  const latest = new Map(metricMeasurements(graph).map((item) => [item.metricId, item.latest]));
  for (const id of goals) {
    const goal = nodes.get(id);
    if (!goal || goal.attributes.typeId !== goalType) continue;
    kpis.push(...goalKpis(graph, goal, nodes, metricType, measuredBy, latest));
  }
  return kpis;
}

function deliveryUpdates(
  graph: ProgressGraph,
  organization: EntityRecord,
  documents: EntityRecord[],
  now: Date,
) {
  const documentType = typeId(graph, "Document", "node");
  const updates: OrganizationProgress["updates"] = [];
  const documentsEdge = typeId(graph, "documents", "edge");
  const linkedDocuments = new Set(
    (documentType && documentsEdge ? graph.edges : [])
      .filter(
        (edge) =>
          active(edge) &&
          edge.attributes.typeId === documentsEdge &&
          edge.attributes.toId === organization.ref.id,
      )
      .map((edge) => String(edge.attributes.fromId)),
  );
  for (const record of new Map(
    documents.map((record) => [record.ref.id, record]),
  ).values()) {
    if (
      !active(record) ||
      record.attributes.typeId !== documentType ||
      !linkedDocuments.has(record.ref.id)
    )
      continue;
    const update = body(record);
    if (
      update?.kind !== "delivery-update" ||
      typeof update.shippedAt !== "string" ||
      !z.iso.datetime({ offset: true }).safeParse(update.shippedAt).success ||
      Date.parse(update.shippedAt) > now.getTime() ||
      typeof update.summary !== "string" ||
      !update.summary.trim() ||
      typeof update.benefit !== "string" ||
      !update.benefit.trim()
    )
      continue;
    updates.push({
      id: record.ref.id,
      title: record.title,
      summary: update.summary,
      benefit: update.benefit,
      shippedAt: new Date(update.shippedAt).toISOString(),
      sourceUrl: safeSource(update.sourceUrl),
      staged: update.staged === true,
    });
  }
  return updates;
}

/** Display recorded targets separately from metrics that have no connected observations. */
export function organizationProgressView(
  graph: ProgressGraph,
  identity: AppIdentity,
  documents: EntityRecord[] = [],
  now = new Date(),
): OrganizationProgress {
  const organization = anchor(graph, identity);
  if (!organization) return { kpis: [], updates: [] };
  const kpis = progressKpis(graph, organization);
  const updates = deliveryUpdates(graph, organization, documents, now);
  return {
    kpis: kpis.sort((a, b) => a.title.localeCompare(b.title)),
    updates: updates.sort(
      (a, b) =>
        Date.parse(b.shippedAt) - Date.parse(a.shippedAt) ||
        a.id.localeCompare(b.id),
    ),
  };
}

async function deliveryDocumentEdges(
  database: Awaited<ReturnType<Context["apps"]["installation"]>>,
  organization: EntityRecord,
  documentsType: string,
) {
  const edges = database.collection("edges");
  const ids = new Set<string>();
  const documentEdges: EntityRecord[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await edges.list({
      where: {
        typeId: documentsType,
        toId: organization.ref.id,
        archived: false,
      },
      select: ["typeId", "fromId", "toId", "archived"],
      offset,
      limit: 100,
    });
    for (const edge of page)
      if (
        active(edge) &&
        edge.attributes.typeId === documentsType &&
        edge.attributes.toId === organization.ref.id
      ) {
        ids.add(String(edge.attributes.fromId));
        documentEdges.push(edge);
      }
    if (ids.size > 1000)
      throw new Response(
        "Organization delivery context exceeds its read bound",
        { status: 413 },
      );
    if (page.length < 100) break;
  }
  return { ids, documentEdges };
}

/** Extend the already scoped overview with only the current organization's delivery documents. */
export async function readOrganizationProgress(
  context: Context,
  identity: AppIdentity,
  graph: ProgressGraph,
): Promise<OrganizationProgress> {
  const organization = anchor(graph, identity);
  const documentsType = typeId(graph, "documents", "edge");
  const documentType = typeId(graph, "Document", "node");
  if (!organization || !documentsType || !documentType)
    return organizationProgressView(graph, identity);
  const database = await context.apps.installation(graph.wiki.installationId);
  const { ids, documentEdges } = await deliveryDocumentEdges(
    database,
    organization,
    documentsType,
  );
  const cached = new Map(graph.nodes.map((record) => [record.ref.id, record]));
  const documents: EntityRecord[] = [];
  const pending = [...ids];
  for (let offset = 0; offset < pending.length; offset += 8) {
    const records = await Promise.all(
      pending.slice(offset, offset + 8).map(async (id) => {
        if (cached.has(id)) return cached.get(id);
        try {
          return await database.collection("nodes").get(id);
        } catch (error) {
          if (error instanceof Response && error.status === 404)
            return undefined;
          throw error;
        }
      }),
    );
    for (const record of records) if (record) documents.push(record);
  }
  return organizationProgressView(
    { ...graph, edges: [...graph.edges, ...documentEdges] },
    identity,
    documents,
  );
}
