// The context Foundry's server code runs with on a request: what the platform's action
// dispatch builds for an action (actionAPI adds the caller's identity and actors itself) and
// what a page or route building its own IntakeContext (to run a document) needs.
import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { requestActor, requestIdentity, requestOriginActor } from "@ai-outfitter/app-sdk/server";
import type { StorageLocals } from "@ai-outfitter/app-sdk/storage";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import type { IntakeContext } from "./intake";

/** The services every Foundry action and document runs with: the host, database, origin and storage. */
export const foundryServices = (request: Request, locals: unknown): Omit<IntakeContext, "identity" | "actor" | "originActor"> => ({
  host: () => workflowHost<"interactive">(locals as never),
  db: () => installationDatabase(),
  origin: new URL(request.url).origin,
  storageLocals: locals as StorageLocals,
});

/** A route's full context: the request's verified identity and actors with the services. */
export function foundryContext(request: Request, locals: unknown): IntakeContext {
  const identity = requestIdentity(request);
  return { identity, actor: requestActor(request, identity), originActor: requestOriginActor(request, identity), ...foundryServices(request, locals) };
}
