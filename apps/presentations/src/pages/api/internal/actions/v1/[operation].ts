import type { APIRoute } from "astro";
import { actionAPI } from "@ai-outfitter/app-sdk/actions";
import { graphqlAction, mutateAction } from "@ai-outfitter/app-sdk/app-graphql";
import { services } from "../../../../../server/context";
import { graphqlSchema } from "../../../../../server/graphql";
export const ALL: APIRoute = ({ request, params, locals }) => {
  if (import.meta.env.OUTFITTER_APP_MODE !== "operational")
    return new Response("Read-only demo", { status: 403 });
  return actionAPI(
    request,
    params.operation ?? "",
    {
      "graph.graphql": graphqlAction(graphqlSchema),
      "graph.mutate": mutateAction(graphqlSchema),
    },
    () => services(request, locals),
  );
};
