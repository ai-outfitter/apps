import type { APIRoute } from "astro";
import { actionAPI } from "@ai-outfitter/app-sdk/actions";
import { graphqlAction, mutateAction } from "@ai-outfitter/app-sdk/app-graphql";
import { respond } from "@ai-outfitter/app-sdk/server";
import { forerunnerServices } from "../../../../../server/context";
import { graphqlSchema } from "../../../../../server/graphql";

// The reserved actions route: only platform dispatch reaches it. It serves graph.graphql
// and graph.mutate, which the platform calls because the manifest declares graph.serve.
// graph.mutate admits every member: each writes their own private board; the daily
// run's field requires an editor itself.
const actions = { "graph.graphql": graphqlAction(graphqlSchema), "graph.mutate": mutateAction(graphqlSchema, { canInvoke: () => true }) };

export const ALL: APIRoute = ({ request, params, locals }) =>
  respond(() => actionAPI(request, params.operation ?? "", actions, () => forerunnerServices(locals)));
