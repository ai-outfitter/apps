/**
 * Project-owned Wiki associations for the Projects document and project pages. The
 * records come from the Wiki's bounded `graph.query` (wiki-subgraph.ts): one read for
 * every project of a GraphQL execution, batched by microtask, and the same in-memory
 * rules as the project pages (`project-readiness.ts`) select from it. A Wiki whose
 * package predates the query's filters answers 400 and gets the whole-graph read.
 */
import { readWikiGraph } from "@ai-outfitter/app-sdk/graph-client";
import { assessProjectReadiness, type ProjectReadiness, projectContextRecords, projectWikiSlug } from "../project-readiness";
import type { PlanningContext } from "./intake";
import { readProjectSubgraph } from "./wiki-subgraph";

type Records = ReturnType<typeof projectContextRecords>;
type Answer = { records: Records; slug: string | null; readiness: ProjectReadiness };
type Waiter = { resolve: (answer: Answer) => void; reject: (error: unknown) => void };
type Graph = Parameters<typeof projectContextRecords>[0];
const cache = Symbol("project-context");
type State = {
  answers: Map<string, Promise<Answer>>;
  /** Projects asked for in the current tick, sent together on the next microtask. */
  pending: Map<string, Waiter>;
  flushing: boolean;
  graph?: Promise<Graph>;
};
type Context = Pick<PlanningContext, "host" | "identity"> & { [cache]?: State };

const answerFrom = (graph: Graph, installationId: string, projectId: string): Answer => ({
  records: projectContextRecords(graph, installationId, projectId),
  slug: projectWikiSlug(graph, installationId, projectId),
  readiness: assessProjectReadiness(graph, installationId, projectId),
});

/** The records for this batch: the bounded read, or the whole graph for a Wiki without the filters. */
async function recordsFor(context: Context, state: State, ids: string[]): Promise<Graph> {
  try {
    return await readProjectSubgraph(context.host(), context.identity.installationId, ids, { products: true });
  } catch (error) {
    if (!(error instanceof Response) || ![400, 404].includes(error.status)) throw error;
    // A Wiki that rejects the filters (an older package): the whole graph, once per execution.
    state.graph ??= readWikiGraph(context.host());
    return state.graph;
  }
}

async function flush(context: Context, state: State) {
  const batch = [...state.pending];
  state.pending = new Map();
  state.flushing = false;
  let graph: Graph;
  try {
    graph = await recordsFor(context, state, batch.map(([id]) => id));
  } catch (error) {
    for (const [, waiter] of batch) waiter.reject(error);
    return;
  }
  for (const [id, waiter] of batch) {
    try { waiter.resolve(answerFrom(graph, context.identity.installationId, id)); } catch (error) { waiter.reject(error); }
  }
}

function answer(context: Context, projectId: string) {
  context[cache] ??= { answers: new Map(), pending: new Map(), flushing: false };
  const state = context[cache];
  let promise = state.answers.get(projectId);
  if (!promise) {
    promise = new Promise<Answer>((resolve, reject) => state.pending.set(projectId, { resolve, reject }));
    state.answers.set(projectId, promise);
    if (!state.flushing) {
      state.flushing = true;
      queueMicrotask(() => void flush(context, state));
    }
  }
  return promise;
}

export async function projectContext(context: Context, projectId: string) {
  return (await answer(context, projectId)).records;
}

export async function projectSlug(context: Context, projectId: string) {
  return (await answer(context, projectId)).slug;
}

/** The project's readiness (stage, what is missing, signals), from the same read as its context. */
export async function projectReadiness(context: Context, projectId: string) {
  return (await answer(context, projectId)).readiness;
}
