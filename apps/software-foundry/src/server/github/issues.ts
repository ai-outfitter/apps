import { z } from "zod";
import {
  type GraphQL,
  githubReadFailure,
  graphqlErrors,
  requireAnsweredQuery,
} from "./graphql";

export const ISSUE_PAGE_SIZE = 30;
export type IssueOrder = "recent" | "oldest";
/** GitHub's opaque connection cursor, passed back only as a GraphQL variable. */
export const issueCursor = z
  .string()
  .regex(/^[A-Za-z0-9+/=_-]{1,200}$/);
export type IssuePageRequest = { repository: string; cursor?: string | null };
export type RepositoryIssuePage =
  | {
      repository: string;
      issues: {
        number: number;
        title: string;
        url: string;
        updatedAt: string;
        createdAt: string;
      }[];
      nextCursor: string | null;
    }
  | { repository: string; error: string };

const issueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const connectionSchema = z
  .object({
    issues: z.object({
      nodes: z.array(issueSchema.nullable()),
      pageInfo: z.object({
        hasNextPage: z.boolean(),
        endCursor: z.string().nullable(),
      }),
    }),
  })
  .nullable()
  .optional();
const resultSchema = z.object({
  data: z.record(z.string(), connectionSchema).nullable().optional(),
  errors: graphqlErrors,
});
type IssueResult = z.infer<typeof resultSchema>;

// Recent: last updated first. Oldest: the backlog, oldest created first.
const orderings: Record<IssueOrder, string> = {
  recent: "{field:UPDATED_AT,direction:DESC}",
  oldest: "{field:CREATED_AT,direction:ASC}",
};

/**
 * One aliased `repository` field per requested repository. Owners, names and
 * cursors are variables, never inlined; only the alias index and the fixed
 * ordering literal are part of the query text. Repository issues exclude
 * pull requests.
 */
export function issuesQuery(pages: IssuePageRequest[], order: IssueOrder) {
  const declarations = pages
    .map((_, index) => `$o${index}:String!,$n${index}:String!,$c${index}:String`)
    .join(",");
  const fields = pages
    .map(
      (_, index) =>
        `r${index}:repository(owner:$o${index},name:$n${index}){issues(first:${ISSUE_PAGE_SIZE},states:OPEN,orderBy:${orderings[order]},after:$c${index}){nodes{number title createdAt updatedAt}pageInfo{hasNextPage endCursor}}}`,
    )
    .join(" ");
  const variables: Record<string, string | null> = {};
  pages.forEach(({ repository, cursor }, index) => {
    const [owner, name] = repository.split("/");
    variables[`o${index}`] = owner;
    variables[`n${index}`] = name;
    variables[`c${index}`] = cursor ?? null;
  });
  return { query: `query(${declarations}){${fields}}`, variables };
}

function repositoryPage(
  repository: string,
  alias: string,
  data: NonNullable<IssueResult["data"]>,
  failed: Set<unknown>,
): RepositoryIssuePage {
  const connection = data[alias]?.issues;
  if (failed.has(alias) || !connection)
    return {
      repository,
      error: "GitHub could not return this repository's issues.",
    };
  return {
    repository,
    issues: connection.nodes
      .filter((issue) => issue !== null)
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        url: `https://github.com/${repository}/issues/${issue.number}`,
        updatedAt: issue.updatedAt,
        createdAt: issue.createdAt,
      })),
    nextCursor: connection.pageInfo.hasNextPage
      ? connection.pageInfo.endCursor
      : null,
  };
}

/**
 * Open issues for several repositories in one GraphQL request. A field error
 * for one repository becomes that repository's error state; the others are
 * still returned. A GraphQL rate limit fails the whole read with 503.
 */
export async function repositoryIssuePages(
  graphql: GraphQL,
  pages: IssuePageRequest[],
  order: IssueOrder,
): Promise<RepositoryIssuePage[]> {
  if (!pages.length) return [];
  const result = resultSchema.parse(await graphql(issuesQuery(pages, order)));
  requireAnsweredQuery(result.errors);
  const { data } = result;
  if (!data) throw githubReadFailure(503);
  const failed = new Set(result.errors?.map((error) => error.path?.[0]));
  return pages.map(({ repository }, index) =>
    repositoryPage(repository, `r${index}`, data, failed),
  );
}
