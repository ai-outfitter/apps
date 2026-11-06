import type { APIRoute } from "astro";
import { threadProvider } from "@ai-outfitter/app-sdk/threads";
import { requestIdentity } from "@ai-outfitter/app-sdk/server";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { historyTypes, workflowHistory } from "../../../../../server/history";
import { agentRoute } from "../../../../../server/agent-route";
export const POST: APIRoute = async ({ request, params, locals }) => {
  const operation = params.operation ?? "";
  if (operation === "types") {
    if (import.meta.env.OUTFITTER_APP_MODE !== "operational")
      return Response.json([]);
    const response = await agentRoute(request, operation, locals, true);
    if (!response.ok) return response;
    return Response.json([
      ...((await response.json()) as unknown[]),
      ...historyTypes,
    ]);
  }
  if (["list", "get", "entries"].includes(operation)) {
    const history = () =>
      workflowHistory(
        workflowHost<"interactive">(locals),
        requestIdentity(request),
      );
    return threadProvider({
      types: () => historyTypes,
      list: (v) => history().list(v),
      get: (v) => history().get(v),
      entries: (v) => history().entries(v),
    })(request, operation);
  }
  return agentRoute(request, operation, locals, true);
};
