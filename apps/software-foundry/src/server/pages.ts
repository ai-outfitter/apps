import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import type { GraphQL } from "./github/graphql";
import {
  type IssueOrder,
  type IssuePageRequest,
  repositoryIssuePages,
} from "./github/issues";
import {
  answered,
  readMilestones,
  readProjectMilestones,
  withMilestoneRuns,
} from "./github/milestones";
import { type FoundryDatabase, listProjects } from "./projects";
import { groupMilestones, rankMilestones } from "./ranking";

type Host = WorkflowHost<"interactive">;

/** The acting user's available GitHub repositories, in lower case, and read-only GraphQL over them through the host. */
export async function userGithub(host: Host) {
  const { connections } = await host.call("snapshot", {});
  const github = connections.filter((connection) => connection.provider === "github");
  if (github.length !== 1)
    throw new Response("Connect your GitHub account first.", { status: 409 });
  const [connection] = github;
  const graphql: GraphQL = async (body) =>
    host.call("repository.request", { connectionId: connection.id, method: "POST", path: "/graphql", body: body as never });
  return { names: connection.repositories, graphql };
}
type Approved = Awaited<ReturnType<typeof userGithub>>;

// Requests name available repositories in lower case, as connections store them.
export function requireAvailable(approved: Approved, names: string[]) {
  const known = new Set(approved.names);
  if (names.some((name) => !known.has(name)))
    throw new Response(
      "Grant your GitHub account access to this repository first.",
      { status: 403 },
    );
}

/**
 * Open issues for the requested available repositories in one GraphQL request.
 */
export async function issuePages(
  approved: Approved,
  pages: IssuePageRequest[],
  order: IssueOrder,
) {
  requireAvailable(approved, pages.map((page) => page.repository));
  return { order, repositories: await repositoryIssuePages(approved.graphql, pages, order) };
}

export type MilestoneQuery = {
  repository: string;
  state?: "open" | "closed";
  milestone?: number;
};

/**
 * The milestone list, a milestone's detail with recorded runs, or both, read
 * in one GraphQL request. Parts GitHub could not answer come back as error
 * Responses.
 */
export async function milestoneParts(
  host: Host,
  approved: Approved,
  { repository, state, milestone }: MilestoneQuery,
) {
  requireAvailable(approved, [repository]);
  const parts = await readMilestones(approved.graphql, repository, {
    state,
    number: milestone,
    pullRequests: true,
  });
  const detail =
    parts.detail && !(parts.detail instanceof Response)
      ? await withMilestoneRuns(host, parts.detail)
      : parts.detail;
  return { list: parts.list, detail };
}

export type BootstrapQuery =
  | { page: "issues"; order: IssueOrder }
  | {
      page: "milestones";
      repository?: string;
      state: "open" | "closed";
      milestone?: number;
    }
  | { page: "governance"; repository?: string }
  | { page: "dashboard" };
// A page's data error is shown in place of that data; the response still
// carries the repositories so the page can render its controls.
async function part<T>(read: () => Promise<T>) {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof Response)) throw error;
    return { error: await error.text(), status: error.status };
  }
}
// The requested repository when approved, otherwise the first approved one,
// as the page's repository picker chooses.
function selectedRepository(names: string[], requested?: string) {
  return requested && names.includes(requested) ? requested : names[0];
}
async function milestonesPage(
  host: Host,
  approved: Approved,
  query: Extract<BootstrapQuery, { page: "milestones" }>,
) {
  const repository = selectedRepository(approved.names, query.repository);
  const parts = await milestoneParts(host, approved, {
    repository,
    state: query.state,
    milestone: query.milestone,
  });
  return {
    repository,
    state: query.state,
    list: await part(async () => answered(parts.list)),
    detail: parts.detail ? await part(async () => answered(parts.detail)) : null,
  };
}
async function pageData(host: Host, approved: Approved, query: BootstrapQuery) {
  if (query.page === "issues")
    return {
      issues: await part(() =>
        issuePages(approved, approved.names.map((repository) => ({ repository })), query.order),
      ),
    };
  if (query.page === "dashboard") return {};
  if (query.page === "milestones")
    return { milestones: await part(() => milestonesPage(host, approved, query)) };
  // The governance check itself is the platform's GitHub plugin read.
  return { governance: { repository: selectedRepository(approved.names, query.repository) } };
}

/**
 * The organization's projects, highest priority first, and the active
 * project's open milestones ranked most important first: the requested
 * project, else the first. Its available repositories are read in one GraphQL
 * query; a repository GitHub does not answer is listed under `unread`.
 */
async function projectData(
  db: FoundryDatabase,
  identity: AppIdentity,
  approved: Approved,
  requested?: string,
) {
  const { projects } = await listProjects(db, identity);
  const active = projects.find((project) => project.id === requested) ?? projects[0];
  if (!active) return { projects, active: null, milestones: [], unread: [] };
  const repositories = active.repositories.filter((name) => approved.names.includes(name));
  const read = repositories.length
    ? await part(() => readProjectMilestones(approved.graphql, repositories))
    : { projects: [], truncated: false };
  if ("error" in read)
    return { projects, active: active.id, milestones: [], unread: repositories, error: read.error };
  return {
    projects,
    active: active.id,
    milestones: rankMilestones(
      active.milestones,
      groupMilestones(
        repositories,
        read.projects.flatMap((repository) => repository.milestones),
      ),
    ),
    unread: read.projects
      .filter((repository) => "error" in repository)
      .map((repository) => repository.repository),
  };
}

/**
 * Everything a Foundry page needs to render first, in one response: the
 * Foundry projects with the active project's ranked milestones and the page's
 * first data. Organization owners and admins only, like the page data
 * endpoints; anyone else gets 403 and the page falls back to its own endpoints.
 */
export async function foundryBootstrap(
  host: Host,
  db: FoundryDatabase,
  identity: AppIdentity,
  query: BootstrapQuery,
  project?: string,
) {
  const approved = await userGithub(host);
  if (!approved.names.length) return { page: query.page };
  const [foundry, data] = await Promise.all([
    projectData(db, identity, approved, project),
    pageData(host, approved, query),
  ]);
  return { page: query.page, foundry, ...data };
}
