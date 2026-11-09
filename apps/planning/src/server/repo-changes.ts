// What reached each of a project's repositories in a digest window.
//
// The project's Wiki node names its code with `source_in` edges to Repository
// nodes (each edge may scope a monorepo path and a ref). For each GitHub one,
// Planning reads the commits on that ref (the default branch when unset) through
// the organization's GitHub connection with the read-only `commits.list`
// connector operation, each with the merged pull requests that brought it in.
// A repository that cannot be read is reported with its reason, never dropped.
import { readWikiGraph } from "@ai-outfitter/app-sdk/graph-client";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { z } from "zod";
import { type ProjectRepository, projectRepositories } from "../project-readiness";

/** A digest looks back at most this far: since the previous digest when one ran within it, otherwise this many days. */
export const LOOKBACK_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;
/** Commits read per repository and window. */
const COMMIT_LIMIT = 100;
/** Commits kept on a digest per repository; counts stay exact. */
const KEEP = 30;

export const windowStart = (previousAt: number | null, now: number, days = LOOKBACK_DAYS) =>
  previousAt && previousAt >= now - days * DAY ? previousAt : now - days * DAY;

const pullRequest = z.object({ number: z.number(), title: z.string(), url: z.string(), mergedAt: z.string(), author: z.string().nullable() });
const listedCommit = z.object({ sha: z.string(), headline: z.string(), committedAt: z.string(), url: z.string(), author: z.string().nullable(), pullRequests: z.array(pullRequest) });
const listed = z.object({ ref: z.string(), commits: z.array(listedCommit), more: z.boolean() });

export const repositoryChanges = z.object({
  repository: z.string(),
  url: z.string(),
  path: z.string().nullable(),
  ref: z.string().nullable(),
  /** Merged pull requests in the window, newest first. */
  pullRequests: z.array(pullRequest.extend({ commits: z.number() })),
  /** Commits that came in without a merged pull request (direct pushes). */
  directCommits: z.array(listedCommit.omit({ pullRequests: true })),
  commitCount: z.number(),
  more: z.boolean(),
  /** Why the repository could not be read; its lists are empty then. */
  error: z.string().nullable(),
});
export type RepositoryChanges = z.infer<typeof repositoryChanges>;

type Host = WorkflowHost<"interactive"> | WorkflowHost<"schedule">;
type Call = (operation: "connector.execute" | "repository.request" | "snapshot", input: Record<string, unknown>) => Promise<unknown>;
const caller = (host: Host): Call => (operation, input) => (host as unknown as { call: Call }).call(operation, input);

const reason = async (error: unknown) => {
  if (error instanceof Response) return (await error.text().catch(() => "")).slice(0, 200) || `GitHub read failed (${error.status})`;
  return error instanceof Error ? error.message.slice(0, 200) : "GitHub read failed";
};

/** Group a window's commits by the pull request that merged them. */
export function summarizeCommits(repo: ProjectRepository, result: z.infer<typeof listed>): RepositoryChanges {
  const pulls = new Map<number, RepositoryChanges["pullRequests"][number]>();
  const direct: RepositoryChanges["directCommits"] = [];
  for (const { pullRequests, ...commit } of result.commits) {
    if (!pullRequests.length) direct.push(commit);
    for (const pull of pullRequests) {
      const seen = pulls.get(pull.number);
      pulls.set(pull.number, seen ? { ...seen, commits: seen.commits + 1 } : { ...pull, commits: 1 });
    }
  }
  return {
    repository: repo.repository, url: repo.url, path: repo.path, ref: result.ref,
    pullRequests: [...pulls.values()].sort((a, b) => b.mergedAt.localeCompare(a.mergedAt)).slice(0, KEEP),
    directCommits: direct.slice(0, KEEP),
    commitCount: result.commits.length,
    more: result.more,
    error: null,
  };
}

/** The organization's GitHub connection that may list commits, if any. */
async function githubConnection(call: Call): Promise<string | null> {
  const snapshot = (await call("snapshot", {})) as { connections: { id: string; provider: string; owner: string; operations: string[] }[] };
  return snapshot.connections.find((item) => item.provider === "github" && item.owner === "organization" && item.operations.includes("commits.list"))?.id ?? null;
}

/**
 * Each GitHub repository the project's Wiki node links, with what landed on it
 * since `since`. Reads need an editor's request (or the morning run, where the
 * platform allows it); otherwise each repository carries the refusal.
 */
export async function projectRepositoryChanges(host: Host, installationId: string, projectId: string, since: number, until: number,
  readGraph: (host: WorkflowHost<"interactive">) => Promise<Parameters<typeof projectRepositories>[0]> = readWikiGraph): Promise<RepositoryChanges[]> {
  let repositories: ProjectRepository[];
  try {
    repositories = projectRepositories(await readGraph(host as WorkflowHost<"interactive">), installationId, projectId);
  } catch {
    return [];
  }
  if (!repositories.length) return [];
  const call = caller(host);
  const empty = (repo: ProjectRepository, error: string): RepositoryChanges =>
    ({ repository: repo.repository, url: repo.url, path: repo.path, ref: repo.ref, pullRequests: [], directCommits: [], commitCount: 0, more: false, error });
  let connectionId: string | null;
  try {
    connectionId = await githubConnection(call);
  } catch (error) {
    return repositories.map((repo) => empty(repo, `GitHub connection unavailable: ${String(error instanceof Response ? error.status : error)}`));
  }
  if (!connectionId) return repositories.map((repo) => empty(repo, "Connect the organization's GitHub to read this repository."));
  return Promise.all(repositories.map(async (repo): Promise<RepositoryChanges> => {
    try {
      const found = z.object({ id: z.number() }).parse(await call("repository.request", { connectionId, method: "GET", path: `/repos/${repo.repository}` }));
      const result = listed.parse(await call("connector.execute", {
        connectionId, resource: String(found.id), operation: "commits.list",
        input: { since: new Date(since).toISOString(), until: new Date(until).toISOString(), limit: COMMIT_LIMIT, ...(repo.ref ? { ref: repo.ref } : {}), ...(repo.path ? { path: repo.path } : {}) },
      }));
      return summarizeCommits(repo, result);
    } catch (error) {
      return empty(repo, await reason(error));
    }
  }));
}
