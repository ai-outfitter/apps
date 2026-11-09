import { readFileSync } from "node:fs";
import { queryGraph } from "@ai-outfitter/app-sdk/graph-query";
import type { WorkflowHostResult, WorkflowHostScope, WorkflowHostStub } from "@ai-outfitter/app-sdk/workflow-host";

type Member = { userId: string; organizationId?: string; role?: string };
type Caller = { call(path: string, member?: Member, init?: { method?: string; body?: unknown; workflowHost?: WorkflowHostScope }): Promise<Response> };
type Published = { name: string; query: string; federation?: { collection: string; cursorVariable: string; provenance?: string } };

const published = JSON.parse(readFileSync(new URL("../graph/documents.json", import.meta.url), "utf8")) as Published[];
const emptyWiki = { version: 1, installationId: "wiki", types: [], nodes: [], edges: [], selection: null, truncated: false, missingTypes: [] };

/**
 * An installed but empty Wiki for a test host: Wiki discovery finds it and
 * `graph.query` answers with the SDK's own engine, as the Wiki does, and it lists no
 * records. Undefined for
 * every other call, which the host answers itself.
 */
export async function emptyWikiAnswer(operation: string, raw: unknown): Promise<WorkflowHostResult | undefined> {
  const input = (raw ?? {}) as Record<string, unknown>;
  if (operation === "entities.types" && input.template === "wiki-map")
    return { ok: true, value: ["graph-type", "graph-node", "graph-edge"].map((type) => ({
      type, installationId: "wiki", template: "wiki-map", hostname: "wiki.alpha.localhost", writable: false,
      collection: { "graph-type": "types", "graph-node": "nodes", "graph-edge": "edges" }[type], title: type, description: "", schema: {},
    })) };
  if (operation === "actions.call" && input.installationId === "wiki" && input.action === "graph.query")
    return { ok: true, value: await queryGraph(emptyWiki as never, input.input as never) };
  if (operation === "entities.list" && input.installationId === "wiki") return { ok: true, value: [] };
  if (operation === "entities.get" && input.installationId === "wiki") return { ok: false, status: 404, message: "Missing" };
  return undefined;
}

/**
 * Answers Planning's `platform.document` host calls in browser tests the way the
 * platform does: the Viewer lists one organization with Planning, and Planning's own
 * published collection documents run against the app's graph, paged by `limit` and
 * `cursor`, each record carrying the organization's slug as provenance.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: mirror both scoped Viewer and collection responses.
export async function answerPlatformDocument(app: Caller, member: Member, scope: WorkflowHostScope, raw: unknown, organizationSlug = "org"): Promise<WorkflowHostResult> {
  const { document, query, variables = {} } = raw as { document: string; query?: string; variables?: Record<string, unknown> };
  if (document === "Viewer" && query) {
    const projects = published.find(row => row.name === "Projects");
    const goals = published.find(row => row.name === "OrganizationGoals");
    if (!projects || !goals) return {ok:false,status:404,message:"Planning Viewer fields are unavailable"};
    async function run(entry: Published, variables: Record<string, unknown>) {
      const response = await app.call("/api/internal/actions/v1/call",member,{method:"POST",workflowHost:scope,body:{action:"graph.graphql",input:{query:entry.query,operationName:entry.name,variables}}});
      if (!response.ok) throw new Error(await response.text());
      const result = await response.json() as {data?:Record<string,unknown>;errors?:unknown[]};
      if(result.errors?.length) throw new Error(JSON.stringify(result.errors));
      return result.data ?? {};
    }
    try {
      const [projectData,goalData] = await Promise.all([run(projects,{first:50,archived:false,...(variables.after ? {after:variables.after} : {})}),run(goals,{first:1})]);
      return {ok:true,value:{viewer:{orgs:[{slug:organizationSlug,projects:projectData.projects,organizationGoals:goalData.organizationGoals}]}}};
    } catch(error) {return {ok:false,status:502,message:error instanceof Error ? error.message : String(error)};}
  }
  if (document === "Viewer")
    return { ok: true, value: { viewer: { personal: { accessible: false, appSlugs: [] }, organizations: [{ slug: organizationSlug, appSlugs: ["planning"] }] } } };
  const entry = published.find((candidate) => candidate.name === document);
  if (!entry?.federation) return { ok: false, status: 404, message: `${document} is not a published collection` };
  const { limit, cursor, ...rest } = variables;
  const response = await app.call("/api/internal/actions/v1/call", member, {
    method: "POST",
    workflowHost: scope,
    body: { action: "graph.graphql", input: { query: entry.query, operationName: document,
      variables: { ...rest, ...(limit === undefined ? {} : { first: limit }), ...(cursor === undefined ? {} : { [entry.federation.cursorVariable]: cursor }) } } },
  });
  if (!response.ok) return { ok: false, status: response.status, message: await response.text() };
  const result = (await response.json()) as { data?: Record<string, { nodes: Record<string, unknown>[]; pageInfo: { endCursor: string | null; hasNextPage: boolean } }> | null; errors?: unknown[] };
  if (result.errors?.length) return { ok: false, status: 400, message: JSON.stringify(result.errors) };
  const connection = result.data?.[entry.federation.collection];
  const provenance = entry.federation.provenance;
  return {
    ok: true,
    value: {
      data: { [entry.federation.collection]: (connection?.nodes ?? []).map((node) => (provenance ? { ...node, [provenance]: organizationSlug } : node)) },
      ...(connection?.pageInfo.hasNextPage && connection.pageInfo.endCursor ? { next: connection.pageInfo.endCursor } : {}),
    },
  };
}

/**
 * A Planning test host with the platform's side added: `platform.document` and an
 * empty Wiki are answered here (and shown to `observe`); every other call goes to `host`.
 */
export function withPlatform(app: Caller, member: () => Member, scope: WorkflowHostScope, host: WorkflowHostStub, observe?: (operation: string, raw: unknown) => void): WorkflowHostStub {
  return {
    async call(operation, raw) {
      const answer = operation === "platform.document" ? await answerPlatformDocument(app, member(), scope, raw) : await emptyWikiAnswer(operation, raw);
      if (!answer) return host.call(operation, raw);
      observe?.(operation, raw);
      return answer;
    },
  };
}
