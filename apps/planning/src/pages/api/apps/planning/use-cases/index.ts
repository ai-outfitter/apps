import type { APIRoute } from "astro";
import {
  readJSON,
  requestIdentity,
  respond,
} from "@ai-outfitter/app-sdk/server";
import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { planningContext } from "../../../../../server/context";
import { documents, runDocument } from "../../../../../server/documents";
import { listUseCases, useCaseInput } from "../../../../../server/use-cases";
export const GET: APIRoute = ({ request, locals, url }) =>
  respond(() => {
    if (import.meta.env.OUTFITTER_APP_MODE !== "operational")
      throw new Response("Read-only demo", { status: 403 });
    return listUseCases(
      installationDatabase(),
      requestIdentity(request),
      workflowHost<"interactive">(locals),
      url.searchParams.get("projectId") ?? undefined,
    );
  });
/** The use cases page saves through the same SaveUseCase document agents run with graph_mutate. */
export const POST: APIRoute = ({ request, locals }) =>
  respond(async () => {
    if (import.meta.env.OUTFITTER_APP_MODE !== "operational")
      throw new Response("Read-only demo", { status: 403 });
    const input = await readJSON(request, useCaseInput, 40000);
    return (await runDocument(documents.SaveUseCase.document, { input }, planningContext(request, locals))).saveUseCase;
  });
