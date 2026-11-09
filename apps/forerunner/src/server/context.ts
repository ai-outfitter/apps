// The context Forerunner's resolvers run with: what the actions route gives platform
// dispatch (actionAPI adds the caller's identity and actors) and what a page route
// building its own context to run a document needs.
import type { ActionContext } from "@ai-outfitter/app-sdk/actions";
import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { requestActor, requestIdentity, requestOriginActor } from "@ai-outfitter/app-sdk/server";
import { type WorkflowHost, workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import type { Database } from "./items";

/** What every resolver and route runs with: the caller, the installation database and, for the daily run, the workflow host. */
export type ForerunnerContext = ActionContext & { db: () => Database; host: () => WorkflowHost<"interactive"> };

/** The services behind the caller's identity; the host is reached only by a field that needs it. */
export const forerunnerServices = (locals: unknown): Omit<ForerunnerContext, keyof ActionContext> => ({
  db: installationDatabase,
  host: () => workflowHost<"interactive">(locals as never),
});

/** A route's full context: the request's verified identity and actors with the services. */
export function forerunnerContext(request: Request, locals: unknown): ForerunnerContext {
  const identity = requestIdentity(request);
  return { identity, actor: requestActor(request, identity), originActor: requestOriginActor(request, identity), ...forerunnerServices(locals) };
}
