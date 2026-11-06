import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { z } from "zod";
import {
  type GraphQL,
  githubReadFailure as failed,
  graphqlErrors,
  requireAnsweredQuery,
} from "./graphql";

// GraphQL's largest page: at most 100 milestones, and the first 100 issues
// and 100 pull requests of a milestone, read in one query.
const PAGE_SIZE = 100;
// A milestone's issues and pull requests are read up to three pages each and
// shown up to this many, oldest first, as the REST read did.
const ITEM_PAGES = 3;
export const MILESTONE_ITEM_LIMIT = 300;
const RUNS_PER_ISSUE = 3;

const milestoneSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  description: z.string().nullable().optional(),
  state: z.enum(["OPEN", "CLOSED"]),
  openIssueCount: z.number().int().nonnegative(),
  closedIssueCount: z.number().int().nonnegative(),
  dueOn: z.string().nullable().optional(),
  updatedAt: z.string(),
});
const pageInfo = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable().optional(),
});
const issueNode = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(["OPEN", "CLOSED"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const pullNode = issueNode.extend({
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  // Branches and closing references place a pull request under the issue it
  // closes and on top of the pull request whose branch it targets.
  baseRefName: z.string().optional(),
  headRefName: z.string().optional(),
  closingIssuesReferences: z
    .object({
      nodes: z.array(z.object({ number: z.number().int() }).nullable()),
    })
    .optional(),
});
const connection = <T extends z.ZodTypeAny>(node: T) =>
  z.object({ nodes: z.array(node.nullable()), pageInfo });
const detailSchema = milestoneSchema.extend({
  issues: connection(issueNode),
  pullRequests: connection(pullNode).optional(),
});
const resultSchema = z.object({
  data: z
    .object({
      repository: z
        .object({
          milestones: connection(milestoneSchema).nullable().optional(),
          milestone: detailSchema.nullable().optional(),
        })
        .nullable(),
    })
    .nullable()
    .optional(),
  errors: graphqlErrors,
});
type GithubMilestone = z.infer<typeof milestoneSchema>;
type IssueNode = z.infer<typeof issueNode>;
type PullNode = z.infer<typeof pullNode>;
type Connection<T> = {
  nodes: (T | null)[];
  pageInfo: z.infer<typeof pageInfo>;
};
type Detail = z.infer<typeof detailSchema>;

function milestoneView(repository: string, milestone: GithubMilestone) {
  return {
    number: milestone.number,
    title: milestone.title,
    description: milestone.description || "",
    state: milestone.state === "OPEN" ? ("open" as const) : ("closed" as const),
    // GitHub counts issues and pull requests together.
    openItems: milestone.openIssueCount,
    closedItems: milestone.closedIssueCount,
    dueOn: milestone.dueOn || null,
    updatedAt: milestone.updatedAt,
    url: `https://github.com/${repository}/milestone/${milestone.number}`,
  };
}

const MILESTONE_FIELDS =
  "number title description state openIssueCount closedIssueCount dueOn updatedAt";
const ITEM_FIELDS = "number title state createdAt updatedAt";
type ItemConnection = "issues" | "pullRequests";
const itemFields = {
  issues: ITEM_FIELDS,
  pullRequests: `${ITEM_FIELDS} isDraft baseRefName headRefName closingIssuesReferences(first:10){nodes{number}}`,
};
// A milestone connection, oldest first, after the `$<name>` cursor when given.
const items = (name: ItemConnection, after = false) =>
  `${name}(first:${PAGE_SIZE},orderBy:{field:CREATED_AT,direction:ASC}${after ? `,after:$${name}` : ""}){nodes{${itemFields[name]}}pageInfo{hasNextPage endCursor}}`;

export type MilestoneRead = {
  /** The milestone list in this state, due date first. */
  state?: "open" | "closed";
  /** One milestone with its issues and pull requests. */
  number?: number;
  /** Pull requests need Pull requests read; without it none are listed. */
  pullRequests: boolean;
};

/**
 * The list, one milestone's detail, or both, in one GraphQL query. Every
 * value is a variable; the query text only varies by which parts it reads.
 */
export function milestonesQuery(read: MilestoneRead) {
  const parts: string[] = [];
  const declarations = ["$owner:String!", "$name:String!"];
  if (read.state) {
    declarations.push("$states:[MilestoneState!]");
    parts.push(
      `milestones(first:${PAGE_SIZE},states:$states,orderBy:{field:DUE_DATE,direction:ASC}){nodes{${MILESTONE_FIELDS}}pageInfo{hasNextPage}}`,
    );
  }
  if (read.number) {
    declarations.push("$number:Int!");
    const pulls = read.pullRequests ? items("pullRequests") : "";
    parts.push(
      `milestone(number:$number){${MILESTONE_FIELDS} ${items("issues")}${pulls}}`,
    );
  }
  return `query(${declarations.join(",")}){repository(owner:$owner,name:$name){${parts.join(" ")}}}`;
}

/** The next page of these milestone connections, after their cursors. */
export function milestoneItemsQuery(names: ItemConnection[]) {
  const declarations = ["$owner:String!", "$name:String!", "$number:Int!"];
  for (const name of names) declarations.push(`$${name}:String!`);
  const fields = names.map((name) => items(name, true)).join(" ");
  return `query(${declarations.join(",")}){repository(owner:$owner,name:$name){milestone(number:$number){${fields}}}}`;
}

const openFirst = (
  a: { state: string; number: number },
  b: { state: string; number: number },
) =>
  Number(a.state !== "open") - Number(b.state !== "open") ||
  a.number - b.number;

const present = <T>(nodes: (T | null)[]) =>
  nodes.filter((node): node is T => node !== null);

// The last creation time both connections fully cover. A connection with
// more pages may hold older items than the other's newest ones, so items
// after its last node are cut to keep one consistent oldest-first prefix.
function coveredUntil(connections: Connection<{ createdAt: string }>[]) {
  let cutoff = Number.POSITIVE_INFINITY;
  for (const { nodes, pageInfo } of connections) {
    const last = present(nodes).at(-1);
    if (pageInfo.hasNextPage && last)
      cutoff = Math.min(cutoff, Date.parse(last.createdAt));
  }
  return cutoff;
}

/**
 * Merge a milestone's issues and pull requests oldest first, cap them at
 * MILESTONE_ITEM_LIMIT and split them again, each open first. Truncated when
 * either connection has more items or the cap or prefix cut dropped any.
 */
export function milestoneItems(
  repository: string,
  issues: Connection<IssueNode>,
  pullRequests: Connection<PullNode> | undefined,
) {
  const connections = pullRequests ? [issues, pullRequests] : [issues];
  const cutoff = coveredUntil(connections);
  type Tagged =
    { pull: false; node: IssueNode } | { pull: true; node: PullNode };
  const merged: Tagged[] = [
    ...present(issues.nodes).map((node) => ({ pull: false as const, node })),
    ...present(pullRequests?.nodes ?? []).map((node) => ({
      pull: true as const,
      node,
    })),
  ].sort(
    (a, b) =>
      Date.parse(a.node.createdAt) - Date.parse(b.node.createdAt) ||
      a.node.number - b.node.number,
  );
  const kept = merged
    .filter(({ node }) => Date.parse(node.createdAt) <= cutoff)
    .slice(0, MILESTONE_ITEM_LIMIT);
  return {
    issues: kept
      .flatMap((item) => (item.pull ? [] : [issueItem(repository, item.node)]))
      .sort(openFirst),
    pullRequests: kept
      .flatMap((item) => (item.pull ? [pullItem(repository, item.node)] : []))
      .sort(openFirst),
    truncated:
      kept.length < merged.length ||
      connections.some(({ pageInfo }) => pageInfo.hasNextPage),
  };
}

const issueItem = (repository: string, node: IssueNode) => ({
  number: node.number,
  title: node.title,
  state: node.state === "OPEN" ? ("open" as const) : ("closed" as const),
  updatedAt: node.updatedAt,
  url: `https://github.com/${repository}/issues/${node.number}`,
});
const pullStates = {
  OPEN: "open",
  CLOSED: "closed",
  MERGED: "merged",
} as const;
const pullItem = (repository: string, node: PullNode) => ({
  number: node.number,
  title: node.title,
  state: pullStates[node.state],
  draft: node.isDraft,
  base: node.baseRefName ?? null,
  head: node.headRefName ?? null,
  closes: present(node.closingIssuesReferences?.nodes ?? []).map(
    (issue) => issue.number,
  ),
  updatedAt: node.updatedAt,
  url: `https://github.com/${repository}/pull/${node.number}`,
});

// An error at a part's path makes that part unanswerable: permission
// errors are 403, anything else 503.
function partFailure(errors: z.infer<typeof graphqlErrors>, field: string) {
  const error = errors?.find((item) => item.path?.[1] === field);
  if (!error) return null;
  return failed(
    ["FORBIDDEN", "NOT_FOUND"].includes(error.type ?? "") ? 403 : 503,
  );
}

const moreSchema = z.object({
  data: z
    .object({
      repository: z
        .object({
          milestone: z
            .object({
              issues: connection(issueNode).optional(),
              pullRequests: connection(pullNode).optional(),
            })
            .nullable(),
        })
        .nullable(),
    })
    .nullable()
    .optional(),
  errors: graphqlErrors,
});

function nextCursors(detail: Detail) {
  const cursors: Partial<Record<ItemConnection, string>> = {};
  for (const name of ["issues", "pullRequests"] as const) {
    const info = detail[name]?.pageInfo;
    if (info?.hasNextPage && info.endCursor) cursors[name] = info.endCursor;
  }
  return cursors;
}

const appended = <T>(read: Connection<T>, next: Connection<T> | undefined) =>
  next
    ? { nodes: [...read.nodes, ...next.nodes], pageInfo: next.pageInfo }
    : read;

// Later pages of a milestone's issues and pull requests, one query per page
// in sequence, up to ITEM_PAGES each. A page GitHub does not fully answer
// stops the reading, and the detail stays truncated.
async function withMoreItems(
  graphql: GraphQL,
  repository: string,
  number: number,
  detail: Detail,
) {
  const [owner, name] = repository.split("/");
  let read = detail;
  for (let page = 1; page < ITEM_PAGES; page++) {
    const cursors = nextCursors(read);
    const names = Object.keys(cursors) as ItemConnection[];
    if (!names.length) break;
    const result = await graphql({
      query: milestoneItemsQuery(names),
      variables: { owner, name, number, ...cursors },
    })
      .then((body) => moreSchema.parse(body))
      .catch(() => null);
    const next = result?.errors?.length
      ? null
      : result?.data?.repository?.milestone;
    if (!next || names.some((key) => !next[key])) break;
    read = {
      ...read,
      issues: appended(read.issues, next.issues),
      pullRequests:
        read.pullRequests && appended(read.pullRequests, next.pullRequests),
    };
  }
  return read;
}

async function queryMilestones(
  graphql: GraphQL,
  repository: string,
  read: MilestoneRead,
) {
  const [owner, name] = repository.split("/");
  const result = resultSchema.parse(
    await graphql({
      query: milestonesQuery(read),
      variables: {
        owner,
        name,
        ...(read.state ? { states: [read.state.toUpperCase()] } : {}),
        ...(read.number ? { number: read.number } : {}),
      },
    }),
  );
  requireAnsweredQuery(result.errors);
  const repo = result.data?.repository;
  if (!repo) throw failed(403);
  return { repo, errors: result.errors };
}

function listPart(
  repository: string,
  state: "open" | "closed",
  milestones: Connection<GithubMilestone> | null | undefined,
  failure: Response | null,
) {
  if (failure || !milestones) return failure ?? failed(503);
  return {
    repository,
    state,
    milestones: present(milestones.nodes).map((item) =>
      milestoneView(repository, item),
    ),
    truncated: milestones.pageInfo.hasNextPage,
  };
}

function detailPart(
  repository: string,
  detail: z.infer<typeof detailSchema> | null | undefined,
  failure: Response | null,
) {
  // A milestone GitHub does not return is reported as before, as a 403.
  if (failure || !detail) return failure ?? failed(403);
  return {
    repository,
    milestone: milestoneView(repository, detail),
    ...milestoneItems(repository, detail.issues, detail.pullRequests),
    // False when the installation lacks Pull requests read.
    pullRequestsListed: detail.pullRequests !== undefined,
  };
}

export type MilestoneList = Exclude<ReturnType<typeof listPart>, Response>;
export type MilestoneDetail = Exclude<ReturnType<typeof detailPart>, Response>;

/**
 * Read the list, a detail, or both in one GraphQL request. A part GitHub
 * could not answer is returned as the error Response it would have thrown,
 * so a page can show the other part.
 */
export async function readMilestones(
  graphql: GraphQL,
  repository: string,
  read: MilestoneRead,
): Promise<{
  list?: MilestoneList | Response;
  detail?: MilestoneDetail | Response;
}> {
  const { repo, errors } = await queryMilestones(graphql, repository, read);
  const detailFailure = partFailure(errors, "milestone");
  const detail =
    read.number && repo.milestone && !detailFailure
      ? await withMoreItems(graphql, repository, read.number, repo.milestone)
      : repo.milestone;
  return {
    ...(read.state
      ? {
          list: listPart(
            repository,
            read.state,
            repo.milestones,
            partFailure(errors, "milestones"),
          ),
        }
      : {}),
    ...(read.number
      ? {
          detail: detailPart(repository, detail, detailFailure),
        }
      : {}),
  };
}

/** Throw a part's error Response, or return its value. */
export function answered<T>(part: T | Response | undefined): T {
  if (part instanceof Response || part === undefined) throw part ?? failed(503);
  return part;
}

export type IssueRun = {
  id: string;
  title: string;
  status: string;
  updatedAt: number;
};
type RunRow = {
  id: string;
  title: unknown;
  repository: unknown;
  issue: unknown;
  status: string;
  updatedAt: number;
};

/** Attach recorded issue-to-review runs to their issue, newest first. */
export function issueRuns(
  repository: string,
  issueNumbers: number[],
  rows: RunRow[],
) {
  const wanted = new Set(issueNumbers);
  const runs = new Map<number, IssueRun[]>();
  for (const row of [...rows].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const issue = row.issue;
    if (
      typeof row.repository !== "string" ||
      row.repository.toLowerCase() !== repository ||
      typeof issue !== "number" ||
      !Number.isInteger(issue) ||
      !wanted.has(issue)
    )
      continue;
    const list = runs.get(issue) ?? [];
    if (list.length >= RUNS_PER_ISSUE) continue;
    list.push({
      id: row.id,
      title: typeof row.title === "string" ? row.title : `#${issue}`,
      status: row.status === "complete" ? "completed" : row.status,
      updatedAt: row.updatedAt,
    });
    runs.set(issue, list);
  }
  return runs;
}

/** Recorded issue runs of a milestone's issues, through installation-scoped
 * run references: each issue is ranked and capped separately. */
export async function withMilestoneRuns(host: WorkflowHost<"interactive">, detail: MilestoneDetail) {
  const numbers = detail.issues.map((issue) => issue.number);
  if (!numbers.length) return detail;
  const rows = await host.call("workflow.references", {
    selectors: [
      { slot: "triage.inputs.issue", key: "$.repository", subject: "$.number", label: "$.title" },
      { slot: "triage.inputs.event", key: "$.repository.full_name", subject: "$.issue.number", label: "$.issue.title" },
    ],
    key: detail.repository,
    subjects: numbers,
    workflows: ["issue-to-review", "issue-to-merge-workspace", "issue-to-merge-actions-ci"],
    limitPerSubject: RUNS_PER_ISSUE,
  });
  const runs = issueRuns(detail.repository, numbers,
    rows.map((row) => ({ ...row, repository: row.key, issue: row.subject, title: row.label })));
  return { ...detail, issues: detail.issues.map((issue) => ({ ...issue, runs: runs.get(issue.number) ?? [] })) };
}

// Open milestones read per repository for a project's ranking.
const REPOSITORY_MILESTONES = 50;
// Repositories read in one project query.
export const PROJECT_REPOSITORY_READ_LIMIT = 20;

const projectsSchema = z.object({
  data: z
    .record(
      z.string(),
      z
        .object({
          milestones: z.object({ nodes: z.array(milestoneSchema.nullable()) }),
        })
        .nullable(),
    )
    .nullable()
    .optional(),
  errors: graphqlErrors,
});

/** One aliased query: each repository's open milestones, due date first. */
export function projectMilestonesQuery(count: number) {
  const declarations: string[] = [];
  const parts: string[] = [];
  for (let index = 0; index < count; index++) {
    declarations.push(`$o${index}:String!`, `$n${index}:String!`);
    parts.push(
      `r${index}:repository(owner:$o${index},name:$n${index}){milestones(first:${REPOSITORY_MILESTONES},states:[OPEN],orderBy:{field:DUE_DATE,direction:ASC}){nodes{${MILESTONE_FIELDS}}}}`,
    );
  }
  return `query(${declarations.join(",")}){${parts.join(" ")}}`;
}

/**
 * The open milestones of a project's repositories in one GraphQL request. A
 * repository GitHub does not answer carries an error instead of failing the
 * others.
 */
export async function readProjectMilestones(
  graphql: GraphQL,
  repositories: string[],
) {
  const read = repositories.slice(0, PROJECT_REPOSITORY_READ_LIMIT);
  if (!read.length) return { projects: [], truncated: false };
  const variables: Record<string, string> = {};
  read.forEach((repository, index) => {
    const [owner, name] = repository.split("/");
    variables[`o${index}`] = owner;
    variables[`n${index}`] = name;
  });
  const result = projectsSchema.parse(
    await graphql({
      query: projectMilestonesQuery(read.length),
      variables,
    }),
  );
  requireAnsweredQuery(result.errors);
  return {
    projects: read.map((repository, index) => {
      const alias = `r${index}`;
      const answer = result.data?.[alias];
      if (!answer || result.errors?.some((error) => error.path?.[0] === alias))
        return {
          repository,
          error: "Milestones could not be read.",
          milestones: [],
        };
      return {
        repository,
        milestones: present(answer.milestones.nodes).map((milestone) => ({
          repository,
          ...milestoneView(repository, milestone),
        })),
      };
    }),
    truncated: repositories.length > read.length,
  };
}
