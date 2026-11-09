import { agentDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { requestActor,requestIdentity,requestOriginActor,requestPageURL } from "@ai-outfitter/app-sdk/server";
import { serveGraphql } from "@ai-outfitter/app-sdk/app-graphql";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import {getOperationAST,parse} from "graphql";
import { z } from "zod";
import { graphqlSchema,type Context } from "./graphql";
import { documents } from "./documents";

export function context(request:Request,locals:unknown):Context {
 const identity=requestIdentity(request);
 return {identity,actor:requestActor(request,identity),originActor:requestOriginActor(request,identity),database:agentDatabase(),policyCheck:async(policy,subject)=>{
  const result=await workflowHost<"interactive">(locals as never).call("actions.call",{installationId:policy.installationId,action:"document.policy",input:{policyId:policy.id,policyType:policy.type,subject},readOnly:true});
  return z.object({allowed:z.boolean(),revision:z.number().int(),digest:z.string()}).parse(result);
 }};
}
export function mount(request:Request) {
 const path=requestPageURL(request).pathname, marker="/wiki-map";
 const index=path.indexOf(marker);
 return index<0 ? "/" : `${path.slice(0,index+marker.length)}/`;
}
export async function run(name:keyof typeof documents,variables:Record<string,unknown>,ctx:Context) {
 const document=documents[name];
 const operation=getOperationAST(parse(document.document as string))?.operation;
 if(operation!=="query"&&operation!=="mutation")throw new Response("Unsupported document operation",{status:400});
 const result=await serveGraphql({schema:graphqlSchema,query:document.document as string,variables,context:ctx,operation,maxBytes:262144});
 if(result.errors?.length) {
  const error=result.errors[0];throw new Response(error.message,{status:typeof error.extensions?.status==="number"?error.extensions.status:400});
 }
 if(result.extensions?.truncated) throw new Response("Document response exceeds the limit",{status:413});
 return result.data as Record<string,unknown>;
}
