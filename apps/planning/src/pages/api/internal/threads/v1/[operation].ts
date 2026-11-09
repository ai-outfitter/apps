import { intakeAgent } from "../../../../../server/intake-agent";
import { requestActor, requestOriginActor } from "@ai-outfitter/app-sdk/server";
import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import type { APIRoute } from "astro";
import { threadProvider } from "@ai-outfitter/app-sdk/threads";
import { agentDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { requestIdentity } from "@ai-outfitter/app-sdk/server";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { memberSnapshot } from "../../../../../server/agent-route";
import {
  planningConversations,
  planningThreadTypes,
} from "../../../../../server/conversations";

/** Planning's conversation provider; only platform dispatch reaches this prefix. */
export const POST: APIRoute = ({ request, params, locals }) => {
  const operational = import.meta.env.OUTFITTER_APP_MODE === "operational";
  const planning = () => {
    if (!operational) throw new Response("Read-only demo", { status: 403 });
    return planningConversations(
      agentDatabase(),
      requestIdentity(request),
      memberSnapshot(request),
      workflowHost<"interactive">(locals),
    );
  };
  const discovery = () => {
    const identity = requestIdentity(request);
    return intakeAgent({
      identity,
      actor: requestActor(request, identity),
      originActor: requestOriginActor(request, identity),
      db: () => installationDatabase(),
      store: () => agentDatabase(),
      host: () => workflowHost<"interactive">(locals),
    });
  };
  return threadProvider({
    types: () =>
      operational ? [...planningThreadTypes, ...discovery().types] : [],
    prepare: (input) =>
      input.thread.type === "planning.discovery-conversation"
        ? discovery().prepare(input)
        : planning().prepare(input),
    tool: (input) =>
      input.thread.type === "planning.discovery-conversation"
        ? discovery().tool(input)
        : planning().tool(input),
    deleted: (input) =>
      input.type === "planning.discovery-conversation"
        ? discovery().deleting(input)
        : planning().deleting(input),
  })(request, params.operation ?? "");
};
