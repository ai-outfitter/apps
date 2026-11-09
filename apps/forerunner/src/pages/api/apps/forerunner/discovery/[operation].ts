import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import {
  appDiagnosticsEnabled,
  readJSON,
  requestIdentity,
  respond,
} from "@ai-outfitter/app-sdk/server";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import {sessionDownload, workflowSession} from "@ai-outfitter/app-sdk/workflow-session";
import type { APIRoute } from "astro";
import {
  discoveredEntities,
  discoveryActivity,
  discoveryRuns,
  discoverySources,
  getPreview,
  importInput,
  importSamples,
  previewDiscovery,
  previewInput,
  saveDiscovery,
  saveInput,
} from "../../../../../server/discovery";
import { correctionInput, correctMatch, evaluateRun, evaluationInput, matchCandidates, matchesInput } from "../../../../../server/discovery-feedback";

export const ALL: APIRoute = ({ request, params, locals }) =>
  respond(async () => {
    const who = requestIdentity(request),
      db = installationDatabase();
    if (request.method === "GET") return readDiscovery(request, params.operation, locals);
    if (request.method !== "POST")
      throw new Response("Method not allowed", { status: 405 });
    switch (params.operation) {
      case "import": return importSamples(db, who, await readJSON(request, importInput, 256000));
      case "evaluate": return evaluateRun(db, who, await readJSON(request, evaluationInput, 8000));
      case "correct-match": return correctMatch(db, who, workflowHost<"interactive">(locals), await readJSON(request, correctionInput, 8000));
      case "preview":
      case "discover": return previewDiscovery(db, who, workflowHost<"interactive">(locals), await readJSON(request, previewInput, 4000), params.operation === "discover");
      case "save": return saveDiscovery(db, who, workflowHost<"interactive">(locals), await readJSON(request, saveInput, 4000));
    }
    throw new Response("Unknown discovery operation", { status: 404 });
  });

async function runDiagnostics(request: Request, locals: App.Locals) {
  const who = requestIdentity(request), db = installationDatabase();
      if (!appDiagnosticsEnabled(request)) throw new Response("Developer diagnostics are unavailable", { status:404 });
      const id = new URL(request.url).searchParams.get("id") ?? undefined;
      const result = await discoveryRuns(db, who, id);
      if (!id) return { runs: result };
      const run = result as Record<string, unknown>;
      let workflow: unknown = null;
    if (run.workflowRunId) {
        try { workflow = await workflowHost<"interactive">(locals).call("workflow.read", { id: String(run.workflowRunId) }); }
        catch { workflow = { unavailable: "Platform workflow details are unavailable; retained app diagnostics are shown." }; }
      }
      return { run, workflow };
}

async function readDiscovery(request: Request, operation: string | undefined, locals: App.Locals) {
  const who = requestIdentity(request), db = installationDatabase();
  if (operation === "session") return downloadSession(request,locals);
  if (operation === "matches") return matchCandidates(db, who, workflowHost<"interactive">(locals), matchesInput.parse(Object.fromEntries(new URL(request.url).searchParams)));
  if (operation === "activity") return discoveryActivity(db, who, new URL(request.url).searchParams.get("id") ?? undefined);
  if (operation === "runs") return runDiagnostics(request, locals);
  if (operation === "sources") return discoverySources(db, who, workflowHost<"interactive">(locals));
  if (operation === "entities") return discoveredEntities(db, who, workflowHost<"interactive">(locals));
  if (operation === "latest") return { preview: await getPreview(db, who) };
  throw new Response("Unknown discovery operation", { status:404 });
}

async function downloadSession(request:Request,locals:App.Locals){
  const who=requestIdentity(request), db=installationDatabase();
    const id = new URL(request.url).searchParams.get("id");
    if (!id) throw new Response("Run id required",{status:400});
    const run = await discoveryRuns(db,who,id) as Record<string,unknown>;
    const preview=run.previewId || run.legacy ? await getPreview(db,who,String(run.previewId ?? run.id)) : null;
    const history = {id:"app.history",parentId:null,kind:"result" as const,step:"discovery",at:new Date().toISOString(),data:JSON.parse(JSON.stringify({run,preview}))};
    if (run.workflowRunId) {
      const session = await workflowHost<"interactive">(locals).call("session.read",{runId:String(run.workflowRunId)});
      session.entries.push(history);
      session.run.status=String(run.status ?? session.run.status);
      session.run.trigger=sessionTrigger(run.trigger);
      return sessionDownload(session);
    }
    return sessionDownload(workflowSession.parse({format:"outfitter-workflow-session-v1",exportedAt:new Date().toISOString(),
      run:{id,workflowId:"forerunner-discovery",createdBy:who.userId,installationId:who.installationId,organizationId:who.owner.kind === "organization" ? who.owner.id : null,trigger:run.trigger ?? "unknown",status:run.status ?? "unknown",createdAt:Date.parse(String(run.startedAt)) || 0,updatedAt:Date.parse(String(run.updatedAt ?? run.startedAt)) || 0,definition:null,definitionHash:"",packageHash:null},
      inputs:run.input ?? null,outputs:run.output ?? null,attempts:[],entries:[history],gaps:["No linked workflow execution was retained. Exact model calls and replay context are unavailable."]}));

}

function sessionTrigger(value:unknown){ return value === "schedule" ? "schedule" as const : value === "manual" ? "manual" as const : "unknown" as const; }
