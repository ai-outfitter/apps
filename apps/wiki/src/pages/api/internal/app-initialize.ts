import type {APIRoute} from "astro";
import {requestIdentity,requireEditor,respond} from "@ai-outfitter/app-sdk/server";
import {workflowHost} from "@ai-outfitter/app-sdk/workflow-host";
export const POST:APIRoute=({request,locals})=>respond(async()=>{
 requireEditor(requestIdentity(request));
 const host=workflowHost<"interactive">(locals);
 const invocations=await host.call("invocations",{});
 if(invocations.some(invocation=>invocation.name==="batches.seal"&&invocation.enabled))
  await host.call("invocation.save",{name:"batches.seal",owner:"installation",intervalMinutes:60,enabled:false});
 return {initialized:true};
});
