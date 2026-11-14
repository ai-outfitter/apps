import type {APIRoute} from "astro";
import {requestIdentity,requireEditor,respond} from "@ai-outfitter/app-sdk/server";
import {workflowHost} from "@ai-outfitter/app-sdk/workflow-host";
import {agentDatabase} from "@ai-outfitter/app-sdk/cloudflare/database";
import {resumeLegacyImport} from "../../../documents/resume-import";
import {requireGraphCutover} from "../../../documents/cutover";
export const POST:APIRoute=({request,locals})=>respond(async()=>{
 const identity=requestIdentity(request);
 requireEditor(identity);
 const host=workflowHost<"interactive">(locals);
 await requireGraphCutover(agentDatabase(),identity,host);
 await resumeLegacyImport(agentDatabase());
 const invocations=await host.call("invocations",{});
 if(invocations.some(invocation=>invocation.name==="batches.seal"&&invocation.enabled))
  await host.call("invocation.save",{name:"batches.seal",owner:"installation",intervalMinutes:60,enabled:false});
 return {initialized:true};
});
