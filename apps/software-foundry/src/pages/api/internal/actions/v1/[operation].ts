import type { APIRoute } from "astro";
import { actionAPI } from "@ai-outfitter/app-sdk/actions";
import { graphqlAction, mutateAction } from "@ai-outfitter/app-sdk/app-graphql";
import { foundryServices } from "../../../../../server/context";
import { foundryActions } from "../../../../../server/intake";
import { evidenceActions } from "../../../../../server/evidence";
import { graphqlSchema } from "../../../../../server/graphql";

// graph.mutate runs the mutation documents Foundry publishes (src/server/documents.ts) for
// editors; a function with a narrower policy (startWork) refuses inside its own run.
const graph = { "graph.graphql": graphqlAction(graphqlSchema), "graph.mutate": mutateAction(graphqlSchema) };

/** Foundry's actions, reached only through authenticated platform dispatch: the work intake
 * Planning calls, evidence.publish (scripts/evidence-bundle.mjs), and graph.graphql /
 * graph.mutate, which the platform calls because the manifest declares graph.serve. */
export const ALL: APIRoute = ({ request, params, locals }) =>
  actionAPI(request, params.operation ?? "", { ...foundryActions, ...evidenceActions, ...graph }, () => foundryServices(request, locals), { maxCallBytes: 4_010_000 });
