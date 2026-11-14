import { z } from "zod";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const repository = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
  .refine((v) => !v.includes(".."));
const branch = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine((v) => !v.includes("..") && !v.includes("//") && !v.endsWith("/"));
export const githubActivityInput = z
  .strictObject({
    repository,
    branch,
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
  })
  .refine(
    (v) => Date.parse(v.start) < Date.parse(v.end),
    "Expected a nonempty half-open period",
  );
export type GithubActivityInput = z.infer<typeof githubActivityInput>;
/** Caller injects an already-authorized read-only GitHub API transport. */
export type GithubRead = (path: string) => Promise<unknown>;
const pull = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  html_url: z.string(),
  merged_at: z.iso.datetime({ offset: true }).nullable(),
  base: z.object({ ref: z.string() }),
  head: z.object({ sha }),
  merge_commit_sha: sha.nullable(),
});
const commit = z.object({
  sha,
  html_url: z.string(),
  commit: z.object({
    message: z.string(),
    committer: z.object({ date: z.iso.datetime({ offset: true }) }),
  }),
});
const pageSize = 100,
  pageLimit = 10;
/** Read bounded repository pages. Transport authority belongs to the caller;
 * failures, malformed data and pagination caps remain explicit incomplete results. */
export async function captureGithubActivity(
  read: GithubRead,
  raw: GithubActivityInput,
  source?: { connectionId: string },
) {
  const input = githubActivityInput.parse(raw),
    errors: string[] = [];
  const root = `/repos/${input.repository}`,
    start = Date.parse(input.start),
    end = Date.parse(input.end);
  const inPeriod = (value: string) => {
    const t = Date.parse(value);
    return t >= start && t < end;
  };
  const pulls: z.infer<typeof pull>[] = [],
    commits: z.infer<typeof commit>[] = [];
  async function pages<T>(
    kind: string,
    path: (page: number) => string,
    schema: z.ZodType<T>,
    dest: T[],
    key: (row: T) => string,
  ) {
    const previousPages = new Set<string>();
    try {
      for (let n = 1; n <= pageLimit; n++) {
        const value = await read(path(n));
        const rows = z.array(schema).max(pageSize).parse(value);
        if (rows.some((row) => previousPages.has(key(row))))
          errors.push(`${kind}: pagination drift detected`);
        for (const row of rows) previousPages.add(key(row));
        dest.push(...rows);
        if (rows.length < pageSize) return;
      }
      errors.push(`${kind}: pagination limit reached`);
    } catch (error) {
      errors.push(
        `${kind}: ${error instanceof Response ? `HTTP ${error.status}` : "read unavailable or invalid response"}`,
      );
    }
  }
  let branchHead: string | null = null;
  const readHead = async () =>
    z
      .object({ object: z.object({ sha }) })
      .parse(await read(`${root}/git/ref/heads/${input.branch}`)).object.sha;
  try {
    branchHead = await readHead();
  } catch {
    errors.push("branch: head unavailable");
  }
  // Scan all states in ascending creation order: reopening and updates must not
  // shift earlier page membership. Merge time still determines period inclusion.
  await pages(
    "pull requests",
    (n) =>
      `${root}/pulls?state=all&sort=created&direction=asc&per_page=${pageSize}&page=${n}`,
    pull,
    pulls,
    (p) => String(p.number),
  );
  // GitHub commits' date filter concerns committer date. The final filter enforces [start,end).
  await pages(
    "commits",
    (n) =>
      `${root}/commits?sha=${input.branch}&since=${encodeURIComponent(input.start)}&until=${encodeURIComponent(input.end)}&per_page=${pageSize}&page=${n}`,
    commit,
    commits,
    (c) => c.sha,
  );
  try {
    if (!branchHead || (await readHead()) !== branchHead)
      errors.push("branch: head changed during capture");
  } catch {
    errors.push("branch: head recheck unavailable");
  }
  const unique = <T>(items: T[], key: (item: T) => string) => [
    ...new Map(items.map((item) => [key(item), item])).values(),
  ];
  const merged = unique(
    pulls.filter(
      (p) =>
        p.base.ref === input.branch &&
        p.merged_at !== null &&
        inPeriod(p.merged_at),
    ),
    (p) => String(p.number),
  );
  const activity = unique(
    commits.filter((c) => inPeriod(c.commit.committer.date)),
    (c) => c.sha,
  );
  return {
    complete: errors.length === 0,
    errors,
    provenance: {
      provider: "github",
      repository: input.repository,
      branch: input.branch,
      branchHead,
      period: { start: input.start, end: input.end, boundary: "[start,end)" },
      mergeTime: "merged_at",
      commitTime: "committer.date",
      ...(source ? { connectionId: source.connectionId } : {}),
    },
    snapshot: {
      mergedPullRequests: merged.map((p) => ({
        number: p.number,
        title: p.title,
        url: p.html_url,
        mergedAt: p.merged_at,
        headSha: p.head.sha,
        mergeSha: p.merge_commit_sha,
      })),
      commits: activity.map((c) => ({
        sha: c.sha,
        url: c.html_url,
        committedAt: c.commit.committer.date,
        message: c.commit.message,
      })),
    },
  };
}

export type GithubActivityCapture = Awaited<
  ReturnType<typeof captureGithubActivity>
>;
