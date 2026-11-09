import type { ActionContext } from "@ai-outfitter/app-sdk/actions";
import type { GraphContext } from "@ai-outfitter/app-sdk/graph-graphql";
import type { PullRequestHost } from "@ai-outfitter/app-sdk/github-pulls";
import { executeGraphQuery, type GraphGraphqlInput, graphGraphqlInput } from "@ai-outfitter/app-sdk/graph-graphql";
import type { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { GraphQLFieldConfigMap } from "graphql";
import { databaseSource } from "./graph-source";
import { changeQueries } from "./graphql";

/** GraphQL over the same records `graph.query` reads (nodeView already drops private
 * fields), through indexed reads of this Wiki's tables; the schema is generated from
 * its types on every call. Change batches (changeQueries) answer beside them, as the
 * Wiki's printed schema promises the platform. */
export async function graphqlGraphRecords(db: ReturnType<typeof installationDatabase>, identity: AppIdentity, raw: GraphGraphqlInput, context: Partial<Omit<ActionContext, "identity">> & { host?: () => PullRequestHost } = {}) {
  const input = graphGraphqlInput.parse(raw);
  const source = databaseSource(db);
  return executeGraphQuery({
    types: await source.types(), source,
    schemaOptions: { rootExtensions: changeQueries as GraphQLFieldConfigMap<unknown, GraphContext>, typeNames: ["ChangeBatch", "StagedChange", "Exploration", "ExplorationSummary", "ExplorationPicture", "ExplorationNode", "ExplorationEdge", "ExplorationStepResult"] },
    context: { ...context, db: () => db, identity },
    query: input.query, variables: input.variables, operationName: input.operationName, maxBytes: input.maxBytes,
  });
}
