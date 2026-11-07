// The context the app's server code runs with: what the platform's action dispatch builds
// for graph.graphql and graph.mutate (actionAPI adds the caller's identity and actors) and
// what a page route running a document, or the sidebar agent, builds for itself.
import type { ActionContext } from "@ai-outfitter/app-sdk/actions";
import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { requestActor, requestIdentity, requestOriginActor } from "@ai-outfitter/app-sdk/server";
import { type WorkflowHost, workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import type { Database } from "./store";

/** host reaches the member's Wiki through the platform (saving the interview there). */
export type CreativeContext = ActionContext & { db: () => Database; host: () => WorkflowHost<"interactive"> };

export const creativeServices = (locals: unknown): Omit<CreativeContext, keyof ActionContext> => ({
  db: installationDatabase,
  host: () => workflowHost<"interactive">(locals as never),
});

/** A route's full context: the request's verified identity and actors with the database and host. */
export function creativeContext(request: Request, locals: unknown): CreativeContext {
  const identity = requestIdentity(request);
  return { identity, actor: requestActor(request, identity), originActor: requestOriginActor(request, identity), ...creativeServices(locals) };
}
