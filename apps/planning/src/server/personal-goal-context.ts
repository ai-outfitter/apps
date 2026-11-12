import { z } from "zod";
import { canonicalActionValue } from "@ai-outfitter/app-sdk/actions";
import { defaultWiki } from "@ai-outfitter/app-sdk/graph-client";
import { graphGraphqlResult } from "@ai-outfitter/app-sdk/graph-protocol";
import { isRetired } from "@ai-outfitter/app-sdk/knowledge-graph";
import { sha256Hex, type AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";

/** Typed graph source only: a metric definition never becomes an observed value. */
export const personalGoalQuery = `query PersonalGoalContext {
  goals(first: 100) {
    nodes {
      id revision title body properties archived updatedAt
      metrics: edges(types: ["measured_by"], direction: OUTGOING) {
        id revision fromId toId body properties archived
        to {
          __typename id revision title body properties archived updatedAt
        }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;
const record = z.object({ id: z.string().min(1), revision: z.number().int().positive(), title: z.string(),
  body: z.string().nullable(), properties: z.record(z.string(), z.json()).nullable(), archived: z.boolean(), updatedAt: z.string().nullable() });
const metric = record.extend({ __typename: z.string(), calculation: z.string().nullable().optional(), unit: z.string().nullable().optional(), source: z.string().nullable().optional(), interval: z.string().nullable().optional() });
const edge = z.object({ id: z.string().min(1), revision: z.number().int().positive(), fromId: z.string(), toId: z.string(),
  body: z.string().nullable(), properties: z.record(z.string(), z.json()).nullable(), archived: z.boolean(), to: metric.nullable() });
const answer = z.object({ goals: z.object({ nodes: z.array(record.extend({ metrics: z.array(edge).max(100) })).max(100), pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }) }) });
type Ref = { installationId: string; type: "graph-node" | "graph-edge"; id: string; revision: number };
type Goal = z.output<typeof record> & { ref: Ref; metrics: (z.output<typeof metric> & { ref: Ref; relationship: Ref; observation: { status: "unknown"; value: null; reason: string } })[]; observation: { status: "unknown"; reason: string } };
export type PersonalGoalContext = {
  owner: AppIdentity["owner"]; capturedAt: number; complete: boolean; errors: string[];
  source: { installationId: string; query: string; digest: string } | null; references: Ref[]; goals: Goal[];
  completeness: { goalReads: "complete" | "incomplete"; history: "current-records-only"; metricObservations: "unknown" };
  standup: { status: "unavailable"; reason: string };
};
const unknownObservation = { status: "unknown" as const, value: null, reason: "A metric definition describes a measurement method. No supported observation value was read; formulas were not evaluated." };

function goalView(goal: z.output<typeof record> & { metrics: z.output<typeof edge>[] }, reference: (type: Ref["type"], row: {id:string;revision:number}) => Ref, errors: string[]): Goal {
  const metrics: Goal["metrics"] = [];
  for (const relation of goal.metrics.filter(row => !row.archived && !isRetired(row))) {
    const target = relation.to;
    if (relation.fromId !== goal.id || !target || relation.toId !== target.id || target.__typename !== "MetricDefinition") {
      errors.push(`${goal.title}: a metric relationship has no valid MetricDefinition target.`); continue;
    }
    if (target.archived || isRetired(target)) continue;
    metrics.push({ ...target, ref: reference("graph-node", target), relationship: reference("graph-edge", relation), observation: unknownObservation });
  }
  const { metrics: _relationships, ...current } = goal;
  return { ...current, ref: reference("graph-node", goal), metrics,
    observation: { status: "unknown", reason: metrics.length ? "Metric definitions are available; measured progress remains unknown without observations." : "No active linked metric definition or observed progress value was read." } };
}

/** Current personal Wiki observations, never reconstructed historical progress or invented KPIs. */
export async function capturePersonalGoalContext(host: WorkflowHost<"interactive">, actor: AppIdentity, capturedAt = Date.now()): Promise<PersonalGoalContext> {
  if (actor.owner.kind !== "user") throw new Response("Personal goal context requires a personal owner scope", { status: 403 });
  const result: PersonalGoalContext = { owner: actor.owner, capturedAt, complete: false, errors: [], source: null, references: [], goals: [],
    completeness: { goalReads: "incomplete", history: "current-records-only", metricObservations: "unknown" },
    standup: { status: "unavailable", reason: "No standup source contract is configured. Conversation or meeting content was not read." } };
  try {
    const wiki = await defaultWiki(host);
    const response = graphGraphqlResult.parse(await host.call("actions.call", { installationId: wiki.installationId, action: "graph.graphql", readOnly: true,
      input: { query: personalGoalQuery, maxBytes: 262144 } }));
    if (response.errors?.length || response.extensions?.truncated) throw new Error("Personal goal graph read failed or was truncated");
    const data = answer.parse(response.data);
    if (data.goals.pageInfo.hasNextPage) result.errors.push("Personal goals exceed the bounded first 100 records; the source is incomplete.");
    const refs = new Map<string, Ref>();
    const reference = (type: Ref["type"], row: { id: string; revision: number }): Ref => {
      const ref = { installationId: wiki.installationId, type, id: row.id, revision: row.revision };
      const previous = refs.get(`${type}:${row.id}`);
      if (previous && previous.revision !== row.revision) result.errors.push("A goal source changed during capture; exact revisions disagree.");
      refs.set(`${type}:${row.id}`, ref); return ref;
    };
    result.goals = data.goals.nodes.filter(row => !row.archived && !isRetired(row)).map(goal => goalView(goal, reference, result.errors));
    result.references = [...refs.values()].sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`));
    result.source = { installationId: wiki.installationId, query: personalGoalQuery, digest: await sha256Hex(canonicalActionValue(data)) };
    result.complete = result.errors.length === 0;
    result.completeness.goalReads = result.complete ? "complete" : "incomplete";
  } catch { result.errors.push("Personal goal source is unavailable or invalid; goal progress and measurements remain unknown."); }
  return result;
}
