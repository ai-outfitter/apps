import type { APIRoute } from "astro";
import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import {
  readJSON,
  requestIdentity,
  requestActor,
  requestOriginActor,
  respond,
} from "@ai-outfitter/app-sdk/server";
import {
  assertionConfirmInput,
  assertionInspectInput,
  confirmAssertion,
  inspectAssertion,
} from "../../../../../server/ontology-assertions";

export const POST: APIRoute = ({ request, params }) => {
  if (import.meta.env.OUTFITTER_APP_MODE !== "operational")
    return new Response("Read-only demo", { status: 403 });
  return respond(async () => {
    const who = requestIdentity(request),
      db = installationDatabase();
    if (params.operation === "inspect")
      return inspectAssertion(
        db,
        who,
        await readJSON(request, assertionInspectInput, 4000),
      );
    if (params.operation === "confirm")
      return confirmAssertion(
        db,
        who,
        requestActor(request, who),
        requestOriginActor(request, who),
        await readJSON(request, assertionConfirmInput, 4000),
      );
    throw new Response("Not found", { status: 404 });
  });
};
