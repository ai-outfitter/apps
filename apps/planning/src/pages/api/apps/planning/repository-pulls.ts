import { requestIdentity, respond } from "@ai-outfitter/app-sdk/server";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import type { APIRoute } from "astro";
import { z } from "zod";

/** Run the same published, organization-scoped document available to agents. */
export const GET: APIRoute = ({ request, locals }) => respond(async () => {
  if (import.meta.env.OUTFITTER_APP_MODE !== "operational") throw new Response("Read-only demo", { status: 403 });
  requestIdentity(request);
  const projectId = z.uuid().parse(new URL(request.url).searchParams.get("projectId"));
  const host = workflowHost<"interactive">(locals);
  const answer = await host.call("platform.document", { app: "planning", document: "ProjectRepositories", variables: { ids: [projectId], limit: 1 } }) as { data: { projects: { repositories: { nodes: unknown[] } }[] } | null };
  const project = answer.data?.projects?.[0];
  if (!project) throw new Response("Project not found", { status: 404 });
  return { repositories: project.repositories.nodes };
});
