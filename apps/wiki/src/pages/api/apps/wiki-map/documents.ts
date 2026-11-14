import type {APIRoute} from "astro";
import {context,mount,run} from "../../../../documents/context";
import {documents} from "../../../../documents/documents";
import {readText} from "@ai-outfitter/connector-core/http";
import {z} from "zod";
import {readJSON,respond} from "@ai-outfitter/app-sdk/server";
export const POST:APIRoute=({request,locals})=>respond(async()=>{
 if(import.meta.env.OUTFITTER_APP_MODE!=="operational")throw new Response("Read-only demo",{status:403});
 if(Number(request.headers.get("content-length"))>262144)throw new Response("Document too large",{status:413});
 const contentType=request.headers.get("content-type") ?? "";
 const form=contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data");
 let operation:string,variables:Record<string,unknown>;
 if(form){const text=await readText(request,262144);const fields=Object.fromEntries(contentType.includes("multipart/form-data")?await new Response(text,{headers:{"content-type":contentType}}).formData():new URLSearchParams(text));operation=String(fields.operation);delete fields.operation;if(fields.revision)fields.revision=Number(fields.revision) as never;if(fields.slug==="")delete fields.slug;if(operation==="SavePage"&&typeof fields.entityRef==="string")fields.entityRef=JSON.parse(fields.entityRef);variables={input:fields};}
 else {const body=await readJSON(request,z.object({operation:z.string(),variables:z.record(z.string(),z.unknown()).default({})}),262144);operation=body.operation;variables=body.variables ?? {};}
 if(!Object.hasOwn(documents,operation))throw new Response("Unknown document operation",{status:400});
 const result=await run(operation as keyof typeof documents,variables,context(request,locals));
 if(form){const record=Object.values(result)[0] as {id:string};return new Response(null,{status:303,headers:{Location:`${mount(request)}p/${encodeURIComponent(record.id)}`}});}
 return result;
});
