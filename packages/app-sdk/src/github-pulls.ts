// A repository's recent pull requests through the member's GitHub connection (or
// the organization's), for any app that declares `connector.github.pulls.list`.
// Planning shows them on projects; the Wiki's explorations open them from a
// Repository node. Read only; nothing is copied into the app.
import { z } from "zod";

/** `owner/name` for a github.com repository URL, lowercased; null for anything else. */
export function githubRepositoryName(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const match = url.trim().match(/^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

export const githubPullRequest = z.object({
  number: z.number(), title: z.string(), url: z.string(), state: z.string(),
  createdAt: z.string(), updatedAt: z.string(), closedAt: z.string().nullable(), mergedAt: z.string().nullable(),
});
export type GithubPullRequest = z.infer<typeof githubPullRequest>;
const page = z.object({ nodes: z.array(githubPullRequest), pageInfo: z.object({ endCursor: z.string().nullable(), hasNextPage: z.boolean() }) });

type Call = (operation: "connector.execute" | "repository.request" | "snapshot", input: Record<string, unknown>) => Promise<unknown>;
/** Any workflow host; only `call` is used. */
export type PullRequestHost = { call: unknown };

/** The most recently updated pull requests of `repository` (`owner/name`), newest first. */
export async function githubPullRequests(host: PullRequestHost, repository: string, first: number, after?: string | null) {
  const call = (host as { call: Call }).call.bind(host) as Call;
  const snapshot = z.object({ connections: z.array(z.object({ id: z.string(), provider: z.string(), owner: z.string(), operations: z.array(z.string()) })) }).parse(await call("snapshot", {}));
  const connection = snapshot.connections.find(item => item.provider === "github" && item.owner === "user" && item.operations.includes("pulls.list"))
    ?? snapshot.connections.find(item => item.provider === "github" && item.owner === "organization" && item.operations.includes("pulls.list"));
  if (!connection) throw new Error("Connect GitHub in Plugins to read pull requests.");
  if (connection.owner === "user") {
    const [owner, name] = repository.split("/");
    const response = z.object({ data: z.object({ repository: z.object({ pullRequests: page }).nullable() }).nullable(), errors: z.array(z.unknown()).optional() }).parse(await call("repository.request", {
      connectionId: connection.id, method: "POST", path: "/graphql",
      body: { query: "query($owner:String!,$name:String!,$first:Int!,$after:String){repository(owner:$owner,name:$name){pullRequests(first:$first,after:$after,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number title url state createdAt updatedAt closedAt mergedAt} pageInfo{endCursor hasNextPage}}}}", variables: { owner, name, first, after: after ?? null } },
    }));
    if (response.errors?.length || !response.data?.repository) throw new Error("GitHub pull requests are unavailable for this repository.");
    return response.data.repository.pullRequests;
  }
  const found = z.object({ id: z.number().int().positive() }).parse(await call("repository.request", { connectionId: connection.id, method: "GET", path: `/repos/${repository}` }));
  return page.parse(await call("connector.execute", { connectionId: connection.id, resource: String(found.id), operation: "pulls.list", input: { first, after: after ?? null } }));
}
