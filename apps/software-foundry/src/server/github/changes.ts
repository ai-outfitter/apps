import { z } from "zod";
import { type GraphQL, githubReadFailure, graphqlErrors, requireAnsweredQuery } from "./graphql";

/** One pull request merged into a repository: what shipped, read live from GitHub. */
export type Change = {
  repository: string;
  number: number;
  title: string;
  url: string;
  mergedAt: string;
  author: string | null;
  mergeCommit: string | null;
  kind: ChangeKind | null;
  areas: string[];
};
export type ChangeKind = "feature" | "fix" | "maintenance";
export type ChangeRead = { changes: Change[]; failed: string[]; complete: boolean };

const PAGE_SIZE = 50;
const FILES = 100;
/** Repositories asked in one GraphQL request, and pages read per repository (250 merges). */
const CHUNK = 10;
const MAX_PAGES = 5;

const pullSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  mergedAt: z.string().nullable(),
  author: z.object({ login: z.string() }).nullable(),
  mergeCommit: z.object({ oid: z.string() }).nullable(),
  files: z.object({ nodes: z.array(z.object({ path: z.string() }).nullable()) }).nullable(),
});
const searchSchema = z
  .object({
    // Search can return other node kinds; they arrive as empty objects and are skipped.
    nodes: z.array(z.union([pullSchema, z.object({})]).nullable()),
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
  })
  .nullable()
  .optional();
const resultSchema = z.object({
  data: z.record(z.string(), searchSchema).nullable().optional(),
  errors: graphqlErrors,
});

type Walk = { repository: string; cursor: string | null; pages: number };

/**
 * One aliased search per repository for pull requests merged in the window, so every
 * page holds only merges inside it. Search strings and cursors are variables, never inlined.
 */
export function mergedQuery(walks: Walk[], since: string, until: string) {
  const declarations = walks.map((_, i) => `$q${i}:String!,$c${i}:String`).join(",");
  const fields = walks
    .map(
      (_, i) =>
        `r${i}:search(query:$q${i},type:ISSUE,first:${PAGE_SIZE},after:$c${i}){nodes{...on PullRequest{number title url mergedAt author{login}mergeCommit{oid}files(first:${FILES}){nodes{path}}}}pageInfo{hasNextPage endCursor}}`,
    )
    .join(" ");
  const variables: Record<string, string | null> = {};
  walks.forEach(({ repository, cursor }, i) => {
    variables[`q${i}`] = `repo:${repository} is:pr is:merged merged:${since}..${until}`;
    variables[`c${i}`] = cursor;
  });
  return { query: `query(${declarations}){${fields}}`, variables };
}

const maintenance = new Set(["build", "chore", "ci", "deps", "docs", "perf", "refactor", "revert", "style", "test"]);
/** feat → feature, fix → fix, another Conventional Commits type → maintenance; null for any other title. */
export function changeKind(title: string): ChangeKind | null {
  const type = /^([a-z]+)(\([^)]*\))?!?:/i.exec(title)?.[1]?.toLowerCase();
  if (type === "feat") return "feature";
  if (type === "fix") return "fix";
  return type && maintenance.has(type) ? "maintenance" : null;
}

/**
 * The part of a monorepo a file belongs to: its first directory, except that a
 * directory named `apps` or `packages` keeps the next segment
 * (catalog/apps/crm/src/x.ts → catalog/apps/crm). Root files are ".".
 */
export function changeArea(path: string) {
  const segments = path.split("/");
  if (segments.length === 1) return ".";
  const container = segments.slice(0, -1).findIndex((segment) => segment === "apps" || segment === "packages");
  return container >= 0 && container + 2 < segments.length ? segments.slice(0, container + 2).join("/") : segments[0];
}

function toChange(repository: string, pull: z.infer<typeof pullSchema>): Change {
  const paths = pull.files?.nodes.flatMap((file) => (file ? [file.path] : [])) ?? [];
  return {
    repository, number: pull.number, title: pull.title, url: pull.url, mergedAt: pull.mergedAt as string,
    author: pull.author?.login ?? null, mergeCommit: pull.mergeCommit?.oid ?? null, kind: changeKind(pull.title),
    areas: [...new Set(paths.map(changeArea))].sort(),
  };
}

const newestFirst = (a: Change, b: Change) =>
  b.mergedAt.localeCompare(a.mergedAt) || a.repository.localeCompare(b.repository) || b.number - a.number;

/**
 * Pull requests merged into these repositories at or after `since` and before
 * `until` (ISO-8601 with an offset), newest first. Each repository reads at most
 * MAX_PAGES pages; more leaves `complete` false. A repository GitHub did not answer
 * is listed in `failed`, with whatever it returned before; a rate limit fails the read.
 */
export async function readChanges(graphql: GraphQL, repositories: string[], since: string, until: string): Promise<ChangeRead> {
  const found = new Map<string, Change>();
  const read: ChangeRead = { changes: [], failed: [], complete: true };
  let pending: Walk[] = repositories.map((repository) => ({ repository, cursor: null, pages: 0 }));
  while (pending.length) {
    const chunks = Array.from({ length: Math.ceil(pending.length / CHUNK) }, (_, i) => pending.slice(i * CHUNK, (i + 1) * CHUNK));
    const answers = await Promise.all(chunks.map((chunk) => readChunk(graphql, chunk, since, until)));
    pending = answers.flat().flatMap((answer) => record(read, found, answer));
  }
  read.changes = [...found.values()].sort(newestFirst);
  return read;
}

/** Adds one repository's page to the read (a pull request can repeat across pages); returns the walk to continue, if any. */
function record(read: ChangeRead, found: Map<string, Change>, { walk, changes, next }: Awaited<ReturnType<typeof readChunk>>[number]): Walk[] {
  if (!changes) read.failed.push(walk.repository);
  for (const change of changes ?? []) found.set(`${change.repository}#${change.number}`, change);
  if (!next) return [];
  if (next.pages < MAX_PAGES) return [next];
  read.complete = false;
  return [];
}

/** One GraphQL request for up to CHUNK repositories: each one's changes (null when unanswered) and its next page. */
async function readChunk(graphql: GraphQL, chunk: Walk[], since: string, until: string) {
  const result = resultSchema.parse(await graphql(mergedQuery(chunk, since, until)));
  requireAnsweredQuery(result.errors);
  if (!result.data) throw githubReadFailure(503);
  const data = result.data;
  return chunk.map((walk, i) => {
    const search = data[`r${i}`];
    if (!search) return { walk, changes: null, next: null };
    // Search's range includes `until`; a merge at that instant belongs to the next window.
    const changes = search.nodes
      .filter((node): node is z.infer<typeof pullSchema> => node !== null && "number" in node)
      .filter((pull) => pull.mergedAt !== null && Date.parse(pull.mergedAt) < Date.parse(until))
      .map((pull) => toChange(walk.repository, pull));
    const { hasNextPage, endCursor } = search.pageInfo;
    return { walk, changes, next: hasNextPage && endCursor ? { ...walk, cursor: endCursor, pages: walk.pages + 1 } : null };
  });
}
