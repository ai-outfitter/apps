import type { APIRoute } from "astro";
import { respond } from "@ai-outfitter/app-sdk/server";
import { workshopContext } from "../../../../../../server/context";
import { cotsReadInput, readCotsEvidence } from "../../../../../../server/cots-evidence";

export const GET: APIRoute = ({ params, request, locals }) => respond(async () => {
  const query = new URL(request.url).searchParams;
  let parameters: unknown;
  try {
    if (query.has("parameters")) parameters = JSON.parse(query.get("parameters")!);
  } catch {
    throw new Response("Invalid configuration parameters", { status: 400 });
  }
  const selection = cotsReadInput.safeParse({
    projectId: params.id,
    revision: query.has("revision") ? Number(query.get("revision")) : undefined,
    configuration: query.get("configuration") ?? undefined,
    parameters,
    itemId: query.get("itemId") ?? undefined,
  });
  if (!selection.success) throw new Response("Invalid purchased part selection", { status: 400 });
  return readCotsEvidence(workshopContext(request, locals), selection.data);
});
