import { requestIdentity, respond } from "@ai-outfitter/app-sdk/server";
import { readWikiGraph } from "@ai-outfitter/app-sdk/graph-client";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import type { APIRoute } from "astro";
import { z } from "zod";
import { projectRepositoryChanges } from "../../../../server/repo-changes";
import { projectRepositoriesSelection, readProjectSelection } from "../../../../server/wiki-subgraph";

const DAY = 24 * 60 * 60 * 1000;
/** How far back the project page looks for shipped work. */
const SHIPPED_DAYS = 14;

/** What merged into each of the project's repositories over the last two weeks, newest first. */
export const GET: APIRoute = ({ request, locals }) => respond(async () => {
  if (import.meta.env.OUTFITTER_APP_MODE !== "operational") throw new Response("Read-only demo", { status: 403 });
  const identity = requestIdentity(request);
  const projectId = z.uuid().parse(new URL(request.url).searchParams.get("projectId"));
  const host = workflowHost<"interactive">(locals);
  const until = Date.now();
  // Only the project's repository links, not the whole Wiki; the whole graph from a Wiki without graph.query.
  const readGraph = (h: typeof host) => readProjectSelection(h, identity.installationId, projectId, projectRepositoriesSelection)
    .catch((error) => { if (error instanceof Response && [400, 404].includes(error.status)) return readWikiGraph(h); throw error; });
  const repositories = await projectRepositoryChanges(host, identity.installationId, projectId, until - SHIPPED_DAYS * DAY, until, readGraph as never);
  return { days: SHIPPED_DAYS, repositories };
});
