import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { readJSON, requestActor, requestIdentity, requireEditor, respond } from "@ai-outfitter/app-sdk/server";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import type { APIRoute } from "astro";
import { explorationArgs, pictureProviders, listExplorations, mutateExploration, mutateExplorationInput, readExploration } from "../../../../../server/explorations";

/** Pull requests are read live through this request's workflow host. */
const live = (locals: unknown) => pictureProviders(installationDatabase(), () => workflowHost<"interactive">(locals as never));

// The explore page runs what the Exploration documents run: list, read (again after
// each sidebar reply) and the same merge patch agents send with MutateExploration.
export const GET: APIRoute = ({ request, params, locals }) => {
  if (import.meta.env.OUTFITTER_APP_MODE !== "operational") return new Response("Read-only demo", { status: 403 });
  return respond(async () => {
    requestIdentity(request);
    const db = installationDatabase();
    if (params.operation === "list") return listExplorations(db);
    if (params.operation === "get") {
      const exploration = await readExploration(db, explorationArgs.parse({ slug: new URL(request.url).searchParams.get("slug") }).slug, live(locals));
      if (!exploration) throw new Response("No such exploration", { status: 404 });
      return exploration;
    }
    throw new Response("Not found", { status: 404 });
  });
};

export const POST: APIRoute = ({ request, params, locals }) => {
  if (import.meta.env.OUTFITTER_APP_MODE !== "operational") return new Response("Read-only demo", { status: 403 });
  return respond(async () => {
    const who = requestIdentity(request);
    requireEditor(who);
    if (params.operation !== "mutate") throw new Response("Not found", { status: 404 });
    return mutateExploration(installationDatabase(), who, requestActor(request, who), await readJSON(request, mutateExplorationInput, 64000), live(locals));
  });
};
