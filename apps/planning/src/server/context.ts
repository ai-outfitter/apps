// The context Planning's server code runs with on a request: the services the actions
// route hands every action (actionAPI adds the caller's identity and actors), and the
// full context a page route builds to run a document (src/server/documents.ts) in process.
import { storage, type StorageLocals } from "@ai-outfitter/app-sdk/storage";
import type { VideoContext } from "./video-production";
import { agentDatabase, installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { requestMemberIds } from "@ai-outfitter/app-sdk/members";
import { requestActor, requestIdentity, requestOriginActor } from "@ai-outfitter/app-sdk/server";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";

/** The organization directory, database, host and agent store every action and document runs with. */
export const planningServices = (request: Request, locals: unknown): Omit<VideoContext, "identity" | "actor" | "originActor"> => ({
  videoFiles: () => storage(locals as StorageLocals, "video"),
  members: () => requestMemberIds(request),
  db: () => installationDatabase(),
  host: () => workflowHost<"interactive">(locals as never),
  store: () => agentDatabase(),
});

/** A route's full context: the request's verified identity and actors with the services. */
export function planningContext(request: Request, locals: unknown): VideoContext {
  const identity = requestIdentity(request);
  return { identity, actor: requestActor(request, identity), originActor: requestOriginActor(request, identity), ...planningServices(request, locals) };
}
