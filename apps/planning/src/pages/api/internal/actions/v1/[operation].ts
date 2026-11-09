import type { APIRoute } from "astro";
import { actionAPI } from "@ai-outfitter/app-sdk/actions";
import { graphqlAction, mutateAction } from "@ai-outfitter/app-sdk/app-graphql";
import { respond } from "@ai-outfitter/app-sdk/server";
import { planningServices } from "../../../../../server/context";
import { graphqlSchema } from "../../../../../server/graphql";
import { workActions } from "../../../../../server/intake";

// graph.mutate runs the mutation documents Planning publishes (src/server/documents.ts) for
// every member, as its pages do: members share projects and issues, and an assigned agent
// need not be an editor to claim or record work. Each field checks its own policy.
const graph = { "graph.graphql": graphqlAction(graphqlSchema), "graph.mutate": mutateAction(graphqlSchema, { canInvoke: () => true }) };

export const ALL: APIRoute = ({ request, params, locals }) =>
  respond(async () => {
    if (import.meta.env.OUTFITTER_APP_MODE !== "operational")
      throw new Response("Read-only demo", { status: 403 });
    // The platform calls these: graph.serve, and the resident work scans (work.list, work.context).
    return actionAPI(request, params.operation ?? "", { ...workActions, ...graph }, () => planningServices(request, locals));
  });
