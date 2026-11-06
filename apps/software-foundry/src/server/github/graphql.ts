import { z } from "zod";

/** A read-only GraphQL request through the workflow host's approved-repository reads. */
export type GraphQL = (body: { query: string; variables?: Record<string, unknown> }) => Promise<unknown>;

/** A GitHub read a page cannot use: 403 when denied, otherwise 503. */
export const githubReadFailure = (status: 403 | 503) =>
  new Response("GitHub App repository authorization failed", { status });
/** GraphQL errors: GitHub's `type` and the `path` of the field that failed. */
export const graphqlErrors = z
  .array(
    z.object({
      type: z.string().optional(),
      path: z.array(z.union([z.string(), z.number()])).optional(),
    }),
  )
  .optional();
// A rate limit can null any field, and an error without a path is about the
// whole query; neither leaves a trustworthy partial answer.
export function requireAnsweredQuery(errors: z.infer<typeof graphqlErrors>) {
  if (errors?.some((error) => error.type === "RATE_LIMITED" || !error.path?.length))
    throw githubReadFailure(503);
}
