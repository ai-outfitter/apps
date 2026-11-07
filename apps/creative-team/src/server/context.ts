// The context the app's server code runs with: what the platform's action dispatch builds
// for graph.graphql and graph.mutate (actionAPI adds the caller's identity and actors) and
// what a page route running a document, or the sidebar agent, builds for itself.
import type { ActionContext } from "@ai-outfitter/app-sdk/actions";
import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { requestActor, requestIdentity, requestOriginActor } from "@ai-outfitter/app-sdk/server";
import type { Database } from "./store";

export type CreativeContext = ActionContext & { db: () => Database };

export const creativeServices = (): Omit<CreativeContext, keyof ActionContext> => ({ db: installationDatabase });

/** A route's full context: the request's verified identity and actors with the database. */
export function creativeContext(request: Request): CreativeContext {
  const identity = requestIdentity(request);
  return { identity, actor: requestActor(request, identity), originActor: requestOriginActor(request, identity), ...creativeServices() };
}
