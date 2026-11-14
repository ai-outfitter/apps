import { agentDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import {
  requestIdentity,
  requestActor,
  requestOriginActor,
} from "@ai-outfitter/app-sdk/server";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { storage, type StorageLocals } from "@ai-outfitter/app-sdk/storage";
export const services = (_request: Request, locals: unknown) => ({
  store: agentDatabase,
  host: () => workflowHost<"interactive">(locals as never),
  videoFiles: () => storage(locals as StorageLocals, "video"),
});
export function context(request: Request, locals: unknown) {
  const identity = requestIdentity(request);
  return {
    identity,
    actor: requestActor(request, identity),
    originActor: requestOriginActor(request, identity),
    ...services(request, locals),
  };
}
