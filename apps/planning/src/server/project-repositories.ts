import { readWikiGraph } from "@ai-outfitter/app-sdk/graph-client";
import { z } from "zod";
import { githubRepositoryName, projectRepositories, type ProjectRepository } from "../project-readiness";
import type { PlanningContext } from "./intake";
import { projectRepositoriesSelection, readProjectSelection } from "./wiki-subgraph";

type Context = Pick<PlanningContext, "host" | "identity">;
export async function repositories(context: Context, projectId: string, legacy: string): Promise<ProjectRepository[]> {
  let graph: Parameters<typeof projectRepositories>[0];
  try { graph = await readProjectSelection(context.host(), context.identity.installationId, projectId, projectRepositoriesSelection); }
  catch (error) {
    if (!(error instanceof Response) || ![400, 404].includes(error.status)) throw error;
    graph = await readWikiGraph(context.host());
  }
  const found = projectRepositories(graph, context.identity.installationId, projectId);
  const name = githubRepositoryName(legacy);
  if (name && !found.some(repo => repo.repository === name)) found.push({ nodeId: `legacy:${name}`, title: name, repository: name, url: legacy, path: null, ref: null });
  return found.sort((a, b) => a.repository.localeCompare(b.repository) || (a.path ?? "").localeCompare(b.path ?? "") || a.nodeId.localeCompare(b.nodeId));
}

type Call = (operation: "connector.execute" | "repository.request" | "snapshot", input: Record<string, unknown>) => Promise<unknown>;
export async function pullRequests(context: Context, repo: ProjectRepository, first: number, after?: string | null) {
  const call: Call = (operation, input) => (context.host() as unknown as { call: Call }).call(operation, input);
  const snapshot = z.object({ connections: z.array(z.object({ id: z.string(), provider: z.string(), owner: z.string(), operations: z.array(z.string()) })) }).parse(await call("snapshot", {}));
  const connection = snapshot.connections.find(item => item.provider === "github" && item.owner === "user" && item.operations.includes("pulls.list"))
    ?? snapshot.connections.find(item => item.provider === "github" && item.owner === "organization" && item.operations.includes("pulls.list"));
  if (!connection) throw new Error("Connect GitHub in Plugins to read pull requests.");
  if (connection.id === "github:user") {
    const [owner, name] = repo.repository.split("/");
    const response = z.object({ data: z.object({ repository: z.object({ pullRequests: z.object({ nodes: z.array(z.object({ number: z.number(), title: z.string(), url: z.string(), state: z.string(), createdAt: z.string(), updatedAt: z.string(), closedAt: z.string().nullable(), mergedAt: z.string().nullable() })), pageInfo: z.object({ endCursor: z.string().nullable(), hasNextPage: z.boolean() }) }) }).nullable() }).nullable(), errors: z.array(z.unknown()).optional() }).parse(await call("repository.request", {
      connectionId: connection.id, method: "POST", path: "/graphql",
      body: { query: "query($owner:String!,$name:String!,$first:Int!,$after:String){repository(owner:$owner,name:$name){pullRequests(first:$first,after:$after,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number title url state createdAt updatedAt closedAt mergedAt} pageInfo{endCursor hasNextPage}}}}", variables: { owner, name, first, after: after ?? null } },
    }));
    if (response.errors?.length || !response.data?.repository) throw new Error("GitHub pull requests are unavailable for this repository.");
    return response.data.repository.pullRequests;
  }
  const found = z.object({ id: z.number().int().positive() }).parse(await call("repository.request", { connectionId: connection.id, method: "GET", path: `/repos/${repo.repository}` }));
  return call("connector.execute", { connectionId: connection.id, resource: String(found.id), operation: "pulls.list", input: { first, after: after ?? null } });
}
