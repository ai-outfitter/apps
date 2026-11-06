import type { APIRoute } from "astro";
import { requestIdentity, respond } from "@ai-outfitter/app-sdk/server";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { z } from "zod";
import { issueCursor } from "../../../../server/github/issues";
import { userGithub, issuePages } from "../../../../server/pages";
import { repository } from "../../../../server/projects";

// Repeated `repository` parameters, each with the `cursor` at the same
// position (empty for the first page); without cursors every repository
// starts at its first page.
const issueQuery = z
  .object({
    order: z.enum(["recent", "oldest"]).default("recent"),
    repositories: z.array(repository).min(1).max(50),
    cursors: z.array(z.union([z.literal(""), issueCursor])),
  })
  .refine(
    ({ repositories, cursors }) =>
      new Set(repositories).size === repositories.length &&
      (!cursors.length || cursors.length === repositories.length),
  );

export const GET: APIRoute = ({ request, locals }) =>
  respond(async () => {
    requestIdentity(request);
    const params = new URL(request.url).searchParams;
    const input = issueQuery.safeParse({
      order: params.get("order") ?? undefined,
      repositories: params.getAll("repository"),
      cursors: params.getAll("cursor"),
    });
    if (!input.success) throw new Response("Invalid issue query", { status: 400 });
    const { order, repositories, cursors } = input.data;
    return issuePages(
      await userGithub(workflowHost<"interactive">(locals)),
      repositories.map((repository, index) => ({ repository, cursor: cursors[index] || null })),
      order,
    );
  });
