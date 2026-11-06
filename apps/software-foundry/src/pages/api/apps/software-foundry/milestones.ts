import type { APIRoute } from "astro";
import { requestIdentity, respond } from "@ai-outfitter/app-sdk/server";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { z } from "zod";
import { answered } from "../../../../server/github/milestones";
import { userGithub, milestoneParts } from "../../../../server/pages";
import { repository } from "../../../../server/projects";

const milestoneQuery = z.object({
  repository: repository,
  state: z.enum(["open", "closed"]).default("open"),
  milestone: z.coerce.number().int().min(1).max(1_000_000).optional(),
});

// Milestones and their items are Issues data, read by organization admins. With
// a milestone number only its detail is read, otherwise only the list.
export const GET: APIRoute = ({ request, locals }) =>
  respond(async () => {
    requestIdentity(request);
    const input = milestoneQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!input.success) throw new Response("Invalid milestone query", { status: 400 });
    const { repository, state, milestone } = input.data;
    const host = workflowHost<"interactive">(locals);
    const parts = await milestoneParts(host, await userGithub(host), milestone ? { repository, milestone } : { repository, state });
    return answered(milestone ? parts.detail : parts.list);
  });
