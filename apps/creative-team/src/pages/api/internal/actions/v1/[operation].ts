import type { APIRoute } from "astro";
import { actionAPI } from "@ai-outfitter/app-sdk/actions";
import { graphqlAction, mutateAction } from "@ai-outfitter/app-sdk/app-graphql";
import { respond } from "@ai-outfitter/app-sdk/server";
import { creativeServices } from "../../../../../server/context";
import { graphqlSchema } from "../../../../../server/graphql";

// The reserved actions route: only platform dispatch reaches it. It serves graph.graphql,
// which the platform reads because the manifest declares graph.serve, and graph.mutate,
// which runs the mutation documents the app publishes (src/server/documents.ts) for editors.
const actions = { "graph.graphql": graphqlAction(graphqlSchema), "graph.mutate": mutateAction(graphqlSchema) };

export const ALL: APIRoute = ({ request, params, locals }) =>
  respond(() => actionAPI(request, params.operation ?? "", actions, () => creativeServices(locals)));
