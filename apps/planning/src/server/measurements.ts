// Measurements: KPIs recorded from connectors (docs/measurements.md).
//
// A Measure says how to compute one MetricDefinition from a connector
// operation; a Measurement is one observed value for one window. Planning reads
// every Measure, runs its connector operation for the last completed window, and
// stages the Measurements in one change batch that commits by policy.
import { graphMutateAction } from "@ai-outfitter/app-sdk/app-graphql";
import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";
import type { EvidenceItem } from "@ai-outfitter/app-sdk/evidence";
import { graphGraphqlResult } from "@ai-outfitter/app-sdk/graph-graphql";
import { readWikiGraph, wikiAdapter } from "@ai-outfitter/app-sdk/graph-client";
import { wikiChangeDocuments, wikiGraph } from "@ai-outfitter/app-sdk/graph-contracts";
import { requireEditor, sha256Hex, type AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { z } from "zod";

export const measurementsWorkflow = "record-measurements";
export const measurementsStep = "record";
export const measureType = "e9500000-0000-4000-8000-000000000030";
export const measurementType = "e9500000-0000-4000-8000-000000000031";
export const computesType = "e9500000-0000-4000-8000-000000000032";
export const measurementOfType = "e9500000-0000-4000-8000-000000000033";
export const capturedWithType = "e9500000-0000-4000-8000-000000000034";
/** The graph's standard MetricDefinition type. */
const metricDefinitionType = "71000000-0000-4000-8000-000000000011";
const POLICY_VERSION = "planning-measurements-1";
const DAY = 24 * 60 * 60 * 1000;

const text = (name: string, description: string) => ({ name, type: "string" as const, description, required: false });
/** Planning's measurement definitions; setup is add-only (src/server/wiki-context.ts). */
export const measurementGraph = wikiGraph.parse({
  types: [
    { id: measureType, category: "node", name: "Measure", title: "Measures",
      body: "## Measures\n\nHow to compute one metric from a connector: the connector, its read-only operation, the resource it reads, the operation input (JSON, where `{{windowStart}}` and `{{windowEnd}}` become the window's ISO times), the dot path to the number in the result, its unit and interval. Link the MetricDefinition it computes with `computes`.\n\n## For agents\n\nPlanning's RecordMeasurements runs every Measure and records a Measurement per window. A Measure is a recipe, not an observed value.",
      properties: [
        text("connector", "Connector provider, for example posthog, grafana or github."),
        text("operation", "Read-only connector operation, for example query.run or repositories.read."),
        text("resource", "What the connection reads: a PostHog project (us.posthog.com/projects/4242), a Grafana organization (acme.grafana.net/orgs/1) or a GitHub repository (owner/name)."),
        text("input", "Operation input as JSON; {{windowStart}} and {{windowEnd}} are replaced with the window's ISO times."),
        text("value", "Dot path to the number in the result, for example rows.0.visitors or stars."),
        text("unit", "Unit of the value, for example people or stars."),
        text("interval", "weekly (Monday 00:00 UTC to the next Monday) or daily."),
      ],
      ontology: { version: 2, stereotype: "kind" } },
    { id: measurementType, category: "node", name: "Measurement", title: "Measurements",
      body: "## Measurements\n\nOne observed value of a metric for one half-open window, read from a connector. Zero means the read succeeded and returned zero; a failed read records nothing. Growth is not stored: compare with the previous window's Measurement.\n\n## For agents\n\nRead the MetricDefinition (`measurement_of`) for meaning and the Measure (`captured_with`) for how it was computed. The batch that recorded it keeps the evidence.",
      properties: [
        { name: "value", type: "number", description: "The observed value.", required: true },
        text("unit", "Unit of the value."),
        text("window_start", "Start of the window the value covers (ISO 8601, UTC, inclusive)."),
        text("window_end", "End of the window (ISO 8601, UTC, exclusive)."),
        text("captured_at", "When the connector was read (ISO 8601)."),
      ],
      ontology: { version: 2, stereotype: "event" } },
    { id: computesType, category: "edge", name: "computes", title: "computes",
      body: "The source Measure computes the target MetricDefinition from a connector.", properties: [],
      ontology: { version: 2, endpoints: { from: [measureType], to: [metricDefinitionType] } } },
    { id: measurementOfType, category: "edge", name: "measurement_of", title: "measurement of",
      body: "The source Measurement is an observed value of the target MetricDefinition.", properties: [],
      ontology: { version: 2, endpoints: { from: [measurementType], to: [metricDefinitionType] } } },
    { id: capturedWithType, category: "edge", name: "captured_with", title: "captured with",
      body: "The source Measurement was computed by the target Measure.", properties: [],
      ontology: { version: 2, endpoints: { from: [measurementType], to: [measureType] } } },
  ],
  nodes: [],
  edges: [],
});
export const setupMeasurements = (host: WorkflowHost<"interactive">, installationId: string) =>
  wikiAdapter(host, installationId).setup(measurementGraph);

type Graph = Pick<Awaited<ReturnType<typeof readWikiGraph>>, "types" | "nodes" | "edges"> & { wiki: { installationId: string } };
type Call = (operation: string, input: Record<string, unknown>) => Promise<unknown>;
type Host = WorkflowHost<"interactive"> | WorkflowHost<"schedule">;
const caller = (host: Host): Call => (operation, input) => (host as unknown as { call: Call }).call(operation, input);
const active = (record: EntityRecord) => !record.attributes.archived && !record.attributes.archivedAt;
const props = (record: EntityRecord) => (record.attributes.properties ?? {}) as Record<string, unknown>;
const typeNamed = (graph: Graph, name: string) => graph.types.find((type) => type.attributes.name === name)?.ref.id;

export const measureDefinition = z.object({
  connector: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  operation: z.string().regex(/^[a-z][a-z0-9.-]{0,127}$/),
  resource: z.string().min(1).max(512),
  input: z.string().max(16_000).default("{}"),
  value: z.string().regex(/^[A-Za-z0-9_$]+(\.[A-Za-z0-9_$]+)*$/).max(200),
  unit: z.string().max(80).default(""),
  interval: z.enum(["weekly", "daily"]).default("weekly"),
});
export type MeasureDefinition = z.infer<typeof measureDefinition>;

/** The half-open UTC window containing `at`: a day, or a week starting Monday. */
export function measurementWindow(interval: MeasureDefinition["interval"], at: number) {
  const day = Math.floor(at / DAY) * DAY;
  const start = interval === "daily" ? day : day - ((new Date(day).getUTCDay() + 6) % 7) * DAY;
  return { start: new Date(start).toISOString(), end: new Date(start + (interval === "daily" ? 1 : 7) * DAY).toISOString() };
}

/** The last window that has ended by `at`: a run reads last week (or yesterday), never a week still under way. */
export function completedWindow(interval: MeasureDefinition["interval"], at: number) {
  return measurementWindow(interval, Date.parse(measurementWindow(interval, at).start) - 1);
}

/** The operation input with the window's times filled in. */
export function measureInput(measure: MeasureDefinition, window: { start: string; end: string }) {
  const filled = measure.input.replaceAll("{{windowStart}}", window.start).replaceAll("{{windowEnd}}", window.end);
  const value: unknown = JSON.parse(filled);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Measure input must be a JSON object");
  return value as Record<string, unknown>;
}

/** The finite number at a dot path of a connector result. */
export function measuredValue(result: unknown, path: string) {
  let value: unknown = result;
  for (const key of path.split(".")) {
    if (value === null || typeof value !== "object") throw new Error(`No value at ${path}`);
    value = (value as Record<string, unknown>)[key];
  }
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number)) throw new Error(`The value at ${path} is not a number`);
  return number;
}

type MeasureRecord = { node: EntityRecord; definition: MeasureDefinition; metricIds: string[] };
type Unread = { measureId: string; measure: string; reason: string };

/** Active Measures with a valid definition and the MetricDefinitions they compute. */
function measures(graph: Graph): { found: MeasureRecord[]; unread: Unread[] } {
  const measure = typeNamed(graph, "Measure");
  const computes = typeNamed(graph, "computes");
  const found: MeasureRecord[] = [];
  const unread: Unread[] = [];
  for (const node of graph.nodes.filter((record) => active(record) && record.attributes.typeId === measure)) {
    const definition = measureDefinition.safeParse(props(node));
    if (!definition.success) { unread.push({ measureId: node.ref.id, measure: node.title, reason: "Incomplete Measure: set connector, operation, resource and value." }); continue; }
    const metricIds = graph.edges.filter((edge) => active(edge) && edge.attributes.typeId === computes && edge.attributes.fromId === node.ref.id)
      .map((edge) => String(edge.attributes.toId));
    if (!metricIds.length) { unread.push({ measureId: node.ref.id, measure: node.title, reason: "Link the MetricDefinition this Measure computes." }); continue; }
    found.push({ node, definition: definition.data, metricIds });
  }
  return { found, unread };
}

/** Windows already recorded, by Measure id. */
function recorded(graph: Graph) {
  const measurement = typeNamed(graph, "Measurement");
  const capturedWith = typeNamed(graph, "captured_with");
  const starts = new Map(graph.nodes.filter((node) => active(node) && node.attributes.typeId === measurement)
    .map((node) => [node.ref.id, String(props(node).window_start ?? "")]));
  const seen = new Set<string>();
  for (const edge of graph.edges)
    if (active(edge) && edge.attributes.typeId === capturedWith && starts.has(String(edge.attributes.fromId)))
      seen.add(`${edge.attributes.toId}@${starts.get(String(edge.attributes.fromId))}`);
  return seen;
}

type Snapshot = { connections: { id: string; provider: string; owner: string; operations: string[] }[] };
const reason = async (error: unknown) => {
  if (error instanceof Response) return (await error.text().catch(() => "")).slice(0, 200) || `Connector read failed (${error.status})`;
  return error instanceof Error ? error.message.slice(0, 200) : "Connector read failed";
};

/** The connector resource for a Measure: a GitHub repository by its numeric id, otherwise as written. */
async function connectorResource(call: Call, connectionId: string, measure: MeasureDefinition) {
  if (measure.connector !== "github") return measure.resource;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(measure.resource)) throw new Error("A GitHub Measure's resource is owner/name");
  const found = z.object({ id: z.number() }).parse(await call("repository.request", { connectionId, method: "GET", path: `/repos/${measure.resource}` }));
  return String(found.id);
}

const stableId = async (...parts: string[]) => {
  const hex = await sha256Hex(JSON.stringify(parts));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const slugPart = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "measure";

type Operation = { operation: "create"; ref: string; type: "graph-node" | "graph-edge"; attributes: Record<string, unknown> };
type Proposal = { operation: Operation; evidence: EvidenceItem[]; confidence: number; reason: string };
type Observed = { measure: MeasureRecord; value: number; window: { start: string; end: string }; capturedAt: string };

async function proposalsFor(wikiId: string, observed: Observed, index: number): Promise<Proposal[]> {
  const { measure, value, window, capturedAt } = observed;
  const day = window.start.slice(0, 10);
  const nodeId = await stableId(wikiId, "Measurement", measure.node.ref.id, window.start);
  const slug = String(measure.node.attributes.slug ?? "") || slugPart(measure.node.title);
  const evidence: EvidenceItem[] = [{ provider: measure.definition.connector, recordId: `${measure.definition.resource}:${measure.definition.operation}`, observedAt: capturedAt }];
  const why = `Read ${value} from ${measure.definition.connector} ${measure.definition.operation} on ${measure.definition.resource}.`;
  const proposal = (ref: string, type: Operation["type"], attributes: Record<string, unknown>): Proposal =>
    ({ operation: { operation: "create", type, ref, attributes }, evidence, confidence: 1, reason: why });
  return [
    proposal(`$m${index}`, "graph-node", {
      id: nodeId, typeId: measurementType, title: `${measure.node.title}, ${measure.definition.interval === "daily" ? "" : "week of "}${day}`.slice(0, 160),
      slug: `${slug.slice(0, 68)}-${day}`, summary: `${value}${measure.definition.unit ? ` ${measure.definition.unit}` : ""}`.slice(0, 280),
      properties: { value, unit: measure.definition.unit, window_start: window.start, window_end: window.end, captured_at: capturedAt },
    }),
    proposal(`$m${index}with`, "graph-edge", { id: await stableId(wikiId, "captured_with", nodeId, measure.node.ref.id), typeId: capturedWithType, fromId: nodeId, toId: measure.node.ref.id }),
    ...await Promise.all(measure.metricIds.map(async (metricId, position) => proposal(`$m${index}of${position}`, "graph-edge", {
      id: await stableId(wikiId, "measurement_of", nodeId, metricId), typeId: measurementOfType, fromId: nodeId, toId: metricId,
    }))),
  ];
}

/** Run one of the graph's change-batch documents over its graph.mutate action. */
async function mutate(call: Call, wikiId: string, name: "StageChanges" | "SubmitBatch", input: Record<string, unknown>) {
  const result = graphGraphqlResult.parse(await call("actions.call", {
    installationId: wikiId, action: graphMutateAction,
    input: { query: wikiChangeDocuments[name].document, operationName: name, variables: { input } },
  }));
  const error = result.errors?.[0];
  if (error || result.data === null) throw new Response(error?.message ?? `${name} returned no data`, { status: Number(error?.extensions?.status ?? 422) });
  return result.data as Record<string, { id: string; state: string }>;
}

export const recordMeasurementsInput = z.strictObject({
  /** One Measure by its Wiki id, or every Measure when left out. */
  measureId: z.uuid().optional(),
});
export type RecordResult = { runId: string; batchId: string | null; state: string | null; measures: number; recorded: number; skipped: number; unread: Unread[] };

/** Read every Measure for its last completed window and stage the new Measurements as one batch. Editors only;
 * a schedule runs as the editor who saved it, in the run the platform started (`runId`). */
export async function recordMeasurements(host: Host, identity: AppIdentity, input: unknown,
  { readGraph = readWikiGraph as (host: Host) => Promise<Graph>, now = Date.now(), runId }: { readGraph?: (host: Host) => Promise<Graph>; now?: number; runId?: string } = {}): Promise<RecordResult> {
  requireEditor(identity);
  const { measureId } = recordMeasurementsInput.parse(input);
  const call = caller(host);
  const run = (await call("workflow.start", { workflow: measurementsWorkflow, id: runId ?? crypto.randomUUID(), inputs: {} })) as { id: string };
  const graph = await readGraph(host);
  const all = measures(graph);
  const found = measureId ? all.found.filter((item) => item.node.ref.id === measureId) : all.found;
  const unread = measureId ? all.unread.filter((item) => item.measureId === measureId) : all.unread;
  if (measureId && !found.length && !unread.length) throw new Response("Measure not found", { status: 404 });
  const done = recorded(graph);
  const snapshot = (await call("snapshot", {})) as Snapshot;
  const capturedAt = new Date(now).toISOString();
  const observed: Observed[] = [];
  let skipped = 0;
  for (const measure of found) {
    const window = completedWindow(measure.definition.interval, now);
    if (done.has(`${measure.node.ref.id}@${window.start}`)) { skipped++; continue; }
    const connection = snapshot.connections.find((item) => item.provider === measure.definition.connector && item.owner === "organization" && item.operations.includes(measure.definition.operation));
    if (!connection) { unread.push({ measureId: measure.node.ref.id, measure: measure.node.title, reason: `Connect the organization's ${measure.definition.connector} with ${measure.definition.operation} to record this.` }); continue; }
    try {
      const resource = await connectorResource(call, connection.id, measure.definition);
      const result = await call("connector.execute", { connectionId: connection.id, resource, operation: measure.definition.operation, input: measureInput(measure.definition, window) });
      observed.push({ measure, value: measuredValue(result, measure.definition.value), window, capturedAt });
    } catch (error) {
      unread.push({ measureId: measure.node.ref.id, measure: measure.node.title, reason: await reason(error) });
    }
  }
  const proposals = (await Promise.all(observed.map((item, index) => proposalsFor(graph.wiki.installationId, item, index)))).flat();
  let batch: { id: string; state: string } | null = null;
  if (proposals.length) {
    const opened = (await call("actions.call", { installationId: graph.wiki.installationId, action: "batch.open", input: {
      title: `Measurements ${capturedAt.slice(0, 10)}`,
      purpose: "KPI values read from connectors for the last completed window, one per Measure.",
      source: { kind: "agent-task", ref: run.id, label: "Planning measurements" },
      policy: { kind: "confidence", threshold: 1, version: POLICY_VERSION },
    } })) as { batch: { id: string } };
    for (let i = 0; i < proposals.length; i += 100)
      await mutate(call, graph.wiki.installationId, "StageChanges", { batchId: opened.batch.id, proposals: proposals.slice(i, i + 100) });
    const { submitBatch } = await mutate(call, graph.wiki.installationId, "SubmitBatch", {
      batchId: opened.batch.id, summary: `${observed.length} ${observed.length === 1 ? "measurement" : "measurements"} recorded from connectors.`,
    });
    batch = { id: opened.batch.id, state: submitBatch.state };
  }
  await call("workflow.collect", { runId: run.id, slot: `${measurementsStep}.outputs.recorded`, value: { measures: found.length, recorded: observed.length, skipped } });
  return { runId: run.id, batchId: batch?.id ?? null, state: batch?.state ?? null, measures: found.length, recorded: observed.length, skipped, unread };
}

export type MetricReading = { value: number; unit: string; windowStart: string; windowEnd: string; capturedAt: string };
export type MetricMeasurements = { metricId: string; title: string; latest: MetricReading | null; previous: MetricReading | null; change: number | null };

/** Per MetricDefinition: its latest and previous recorded windows and the change between them. */
export function metricMeasurements(graph: Graph): MetricMeasurements[] {
  const metric = typeNamed(graph, "MetricDefinition");
  const measurement = typeNamed(graph, "Measurement");
  const measurementOf = typeNamed(graph, "measurement_of");
  const readings = new Map(graph.nodes.filter((node) => active(node) && node.attributes.typeId === measurement).flatMap((node) => {
    const p = props(node);
    return typeof p.value === "number" && typeof p.window_start === "string"
      ? [[node.ref.id, { value: p.value, unit: String(p.unit ?? ""), windowStart: p.window_start, windowEnd: String(p.window_end ?? ""), capturedAt: String(p.captured_at ?? "") }] as const]
      : [];
  }));
  const byMetric = new Map<string, MetricReading[]>();
  for (const edge of graph.edges) {
    const reading = readings.get(String(edge.attributes.fromId));
    if (!active(edge) || edge.attributes.typeId !== measurementOf || !reading) continue;
    const list = byMetric.get(String(edge.attributes.toId)) ?? [];
    list.push(reading);
    byMetric.set(String(edge.attributes.toId), list);
  }
  return graph.nodes.filter((node) => active(node) && node.attributes.typeId === metric).map((node) => {
    // One reading per window: the latest capture wins.
    const windows = new Map<string, MetricReading>();
    for (const reading of byMetric.get(node.ref.id) ?? [])
      if ((windows.get(reading.windowStart)?.capturedAt ?? "") <= reading.capturedAt) windows.set(reading.windowStart, reading);
    const [latest = null, previous = null] = [...windows.values()].sort((a, b) => b.windowStart.localeCompare(a.windowStart));
    return { metricId: node.ref.id, title: node.title, latest, previous, change: latest && previous ? latest.value - previous.value : null };
  });
}

export const metricMeasurementsInput = z.strictObject({
  /** Only these MetricDefinitions (Wiki ids); every one when left out. */
  metricIds: z.array(z.uuid()).max(100).optional(),
});
/** The organization's metrics with their recorded values. Members. */
export async function readMetricMeasurements(host: WorkflowHost<"interactive">, input: unknown,
  readGraph: (host: WorkflowHost<"interactive">) => Promise<Graph> = readWikiGraph) {
  const { metricIds } = metricMeasurementsInput.parse(input);
  const all = metricMeasurements(await readGraph(host));
  return metricIds ? all.filter((item) => metricIds.includes(item.metricId)) : all;
}
