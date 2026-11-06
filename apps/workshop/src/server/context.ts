// The context Workshop's server code runs with on a request: the services the actions
// route hands every action (actionAPI adds the caller's identity and actors), and the
// full context a page route builds to run a document (src/server/documents.ts) in process.
import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { requestActor, requestIdentity, requestOriginActor } from "@ai-outfitter/app-sdk/server";
import { type StorageLocals, storage } from "@ai-outfitter/app-sdk/storage";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import type { WorkshopContext, WorkshopServices } from "./graphql";

/** The database, concept storage, workflow host and public origin every action and document runs with. */
export const workshopServices = (request: Request, locals: unknown): WorkshopServices => ({
  db: installationDatabase,
  storage: () => storage(locals as StorageLocals, "main"),
  host: () => workflowHost<"interactive">(locals as never),
  origin: () => new URL(request.url).origin,
});

/** A route's full context: the request's verified identity and actors with the services. */
export function workshopContext(request: Request, locals: unknown): WorkshopContext {
  const identity = requestIdentity(request);
  return { identity, actor: requestActor(request, identity), originActor: requestOriginActor(request, identity), ...workshopServices(request, locals) };
}
