import { readWikiGraph } from "@ai-outfitter/app-sdk/graph-client";
import { githubPullRequests, githubRepositoryName } from "@ai-outfitter/app-sdk/github-pulls";
import { projectRepositories, type ProjectRepository } from "../project-readiness";
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

/** Use the shared owner-aware GitHub read path for both account and organization grants. */
export async function pullRequests(context: Context, repo: ProjectRepository, first: number, after?: string | null) {
  return githubPullRequests(context.host(), repo.repository, first, after);
}
