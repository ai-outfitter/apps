import type { APIRoute } from "astro";
import { respond, readJSON } from "@ai-outfitter/app-sdk/server";
import { workshopContext } from "../../../../../../server/context";
import { requestBuild, requestBuildInput, claimBuild, claimBuildInput, finishBuild, finishBuildInput, artifactKey } from "../../../../../../server/workspace";
import { getWorkshopProject } from "../../../../../../server/projects";
import { z } from "zod";
export const POST:APIRoute=({request,locals,params})=>respond(async()=>{
 const c=workshopContext(request,locals);const action=new URL(request.url).searchParams.get("action")??"request";
 const schema=action==="request"?requestBuildInput:action==="claim"?claimBuildInput:action==="finish"?finishBuildInput:null;
 if(!schema)throw new Response("Unknown action",{status:400});
 const input=await readJSON(request,z.record(z.string(),z.unknown()),2_000_000);
 if(input.id!==params.id)throw new Response("Project mismatch",{status:400});
 if(action==="request")return requestBuild(c,requestBuildInput.parse(input));
 if(action==="claim")return claimBuild(c,claimBuildInput.parse(input));
 return finishBuild(c,finishBuildInput.parse(input));
});
export const PUT:APIRoute=({request,locals,params})=>respond(async()=>{
 const c=workshopContext(request,locals);const input=await readJSON(request,z.object({buildId:z.uuid(),path:z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/).refine(p=>!p.split('/').includes('..')),base64:z.string().max(28_000_000),contentType:z.string().max(100)}).strict(),29_000_000);
 const p=await getWorkshopProject(c.db(),params.id??"");const run=p.workspace?.requests.find(r=>r.id===input.buildId);
 if(!run||run.status!=="running"||run.result)throw new Response("Build is not running",{status:409});
 const key=artifactKey(p.id,run.id,input.path);
 // Content-addressed paths prevent replacing bytes used by a registered result.
 const {sha256}=await import("@noble/hashes/sha2.js");const {bytesToHex}=await import("@noble/hashes/utils.js");
 const bytes=Uint8Array.from(atob(input.base64),c=>c.charCodeAt(0));
 if(!input.path.startsWith(bytesToHex(sha256(bytes))+"/"))throw new Response("Artifact path must start with its SHA-256",{status:400});
 return c.storage().put("builds",key,bytes,{contentType:input.contentType});
});
