import type { ActionContext } from "@ai-outfitter/app-sdk/actions";
import { JSONScalar } from "@ai-outfitter/app-sdk/graph-graphql";
import { GraphQLNonNull, type GraphQLFieldConfig } from "graphql";
import type { createDocumentActions } from "./integration";

export type DocumentContext = Partial<ActionContext> & {
  documentActions?: ReturnType<typeof createDocumentActions>;
};
type Name = keyof ReturnType<typeof createDocumentActions>;
function field(
  name: Name,
  description: string,
): GraphQLFieldConfig<unknown, DocumentContext> {
  return {
    type: new GraphQLNonNull(JSONScalar),
    description,
    args: { input: { type: new GraphQLNonNull(JSONScalar) } },
    resolve: (_root, { input }, context) => {
      if (
        !context.documentActions ||
        !context.identity ||
        !context.actor ||
        !context.originActor
      )
        throw new Response("Document action context unavailable", {
          status: 503,
        });
      return context.documentActions[name].invoke(
        context as ActionContext,
        input,
      );
    },
  };
}
export const documentQueries = {
  documentRevision: field(
    "document.revision",
    "Read an immutable generated revision.",
  ),
  documentLive: field(
    "document.live",
    "Read live authorized sources and completeness.",
  ),
  documentPolicy: field(
    "document.policy",
    "Evaluate exact-revision policy; unavailable is not approval.",
  ),
  documentJob: field(
    "document.job",
    "Inspect generation job status, failure and supersession.",
  ),
};
export const documentMutations = {
  defineDocument: field(
    "document.define",
    "Create an owner-admin controlled definition version.",
  ),
  createDocument: field(
    "document.create",
    "Create a document from an owned definition.",
  ),
  generateDocument: field(
    "document.generate",
    "Queue a durable generation job.",
  ),
  sealDocument: field(
    "document.seal",
    "Seal an exact current revision; sealing is not approval.",
  ),
  retryDocument: field(
    "document.retry",
    "Retry a failed current job as an owner or admin.",
  ),
};
