import type { APIRoute } from "astro";
import { requestIdentity, respond } from "@ai-outfitter/app-sdk/server";
import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { z } from "zod";
import { foundryBootstrap } from "../../../../server/pages";
import { repository } from "../../../../server/projects";

// A Foundry page's first data. Later interactions use the specific endpoints.
const bootstrapQuery = z.discriminatedUnion("page", [
  z.object({ page: z.literal("issues"), order: z.enum(["recent", "oldest"]).default("recent") }),
  z.object({
    page: z.literal("milestones"),
    repository: repository.optional(),
    state: z.enum(["open", "closed"]).default("open"),
    milestone: z.coerce.number().int().min(1).max(1_000_000).optional(),
  }),
  z.object({ page: z.literal("dashboard") }),
  z.object({ page: z.literal("governance"), repository: repository.optional() }),
]);

export const GET: APIRoute = ({ request, locals }) =>
  respond(async () => {
    const params = Object.fromEntries(new URL(request.url).searchParams);
    const query = bootstrapQuery.safeParse(params);
    const project = z.uuid().optional().safeParse(params.project);
    if (!query.success || !project.success)
      throw new Response("Invalid Foundry page query", { status: 400 });
    return foundryBootstrap(
      workflowHost<"interactive">(locals),
      installationDatabase(),
      requestIdentity(request),
      query.data,
      project.data,
    );
  });
