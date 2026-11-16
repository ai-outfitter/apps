import type { APIRoute } from "astro";
import { actionAPI } from "@ai-outfitter/app-sdk/actions";
import { graphqlAction, mutateAction } from "@ai-outfitter/app-sdk/app-graphql";
import { respond } from "@ai-outfitter/app-sdk/server";
import { videoServices } from "../../../../../server/context";
import { graphqlSchema } from "../../../../../server/graphql";

// The reserved actions route: only platform dispatch reaches it. graph.graphql serves the
// Storyboards read; graph.mutate runs StoryboardChanges, which stages an Onto change batch.
const actions = { "graph.graphql": graphqlAction(graphqlSchema), "graph.mutate": mutateAction(graphqlSchema) };

export const ALL: APIRoute = ({ request, params, locals }) =>
  respond(() => actionAPI(request, params.operation ?? "", actions, () => videoServices(locals)));
