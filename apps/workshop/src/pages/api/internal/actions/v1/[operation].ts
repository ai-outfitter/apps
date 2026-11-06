import type { APIRoute } from "astro";
import { actionAPI } from "@ai-outfitter/app-sdk/actions";
import { graphqlAction, mutateAction } from "@ai-outfitter/app-sdk/app-graphql";
import { respond } from "@ai-outfitter/app-sdk/server";
import { workshopServices } from "../../../../../server/context";
import { graphqlSchema } from "../../../../../server/graphql";

// The reserved actions route: only platform dispatch reaches it. It serves graph.graphql,
// which the platform reads because the manifest declares graph.serve, and graph.mutate,
// which runs the mutation documents Workshop publishes (src/server/documents.ts). Every
// member starts and deletes projects and keeps and publishes concepts, as on the page, so
// graph.mutate admits members too.
const actions = { "graph.graphql": graphqlAction(graphqlSchema), "graph.mutate": mutateAction(graphqlSchema, { canInvoke: () => true }) };

export const ALL: APIRoute = ({ request, params, locals }) =>
  respond(() => actionAPI(request, params.operation ?? "", actions, () => workshopServices(request, locals)));
