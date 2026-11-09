import { agentRoute } from "../../../../server/agent-route";
import type { APIRoute } from "astro";
import { z } from "zod";
import {
  readJSON,
  requestIdentity,
  respond,
} from "@ai-outfitter/app-sdk/server";
import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { planningContext } from "../../../../server/context";
import { documents, pageWrite } from "../../../../server/documents";
import type { PlanningContext } from "../../../../server/intake";
import { listPlanning } from "../../../../server/planning";
import { projectCards, readProjectsAndGoals } from "../../../../server/project-page";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";

/** The project page's writes, by `<kind> <method>`, each running the document agents run with
 * graph_mutate (the document validates the input). */
const pageWrites = new Map<string, (input: Record<string, unknown>, context: PlanningContext) => Promise<unknown>>([
  ["issues POST", pageWrite(documents.CreateIssue.document)],
  ["issues PUT", pageWrite(documents.UpdateIssue.document)],
  ["issues DELETE", pageWrite(documents.DeleteIssue.document)],
  ["issues/reorder POST", pageWrite(documents.ReorderIssues.document)],
  ["projects DELETE", pageWrite(documents.DeleteProject.document)],
  ["projects POST", pageWrite(documents.CreateProject.document)],
  ["projects PUT", pageWrite(documents.UpdateProject.document)],
]);

/** The write a request names and the record ID from its path: PUT and DELETE name one, POST does not (or reorders). */
function operation(method: string, path: string) {
  const [kind, id] = path.split("/");
  if (!["projects", "issues"].includes(kind)) throw new Response("Not found", { status: 404 });
  const record = id !== undefined && id !== "reorder";
  const write = pageWrites.get(`${kind}${id === "reorder" ? "/reorder" : ""} ${method}`);
  if (!write || record !== (method === "PUT" || method === "DELETE"))
    throw new Response("Method not allowed", { status: 405 });
  if (record && !z.uuid().safeParse(id).success) throw new Response("Invalid input", { status: 400 });
  return { write, id: record ? id : undefined };
}

const route: APIRoute = ({ request, params, locals }) => {
  const path = params.path ?? "";
  if (path === "agent" || path.startsWith("agent/")) return agentRoute(request, path.slice(6), locals);
  return respond(async () => {
    if (import.meta.env.OUTFITTER_APP_MODE !== "operational")
      throw new Response("Read-only demo", { status: 403 });
    if (request.method === "GET" && !path)
      return listPlanning(installationDatabase(), requestIdentity(request));
    // The projects list, read with the published Projects document as the member's MCP client does.
    if (request.method === "GET" && path === "projects")
    {
      const identity = requestIdentity(request);
      const { projects, goals } = await readProjectsAndGoals(workflowHost<"interactive">(locals), identity);
      return { projects: projectCards(projects, identity), issues: [], organizationGoals: goals };
    }
    const { write, id } = operation(request.method, path);
    const context = planningContext(request, locals);
    const body = await readJSON(request, z.record(z.string(), z.unknown()), 100000);
    return write(id ? { ...body, id } : body, context);
  });
};
export const GET = route;
export const POST = route;
export const PUT = route;
export const DELETE = route;
