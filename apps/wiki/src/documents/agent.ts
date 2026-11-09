import {actionAgent} from "@ai-outfitter/app-sdk/action-agent";
import {defineAction,publishActionTools} from "@ai-outfitter/app-sdk/actions";
import {ProposalStore} from "@ai-outfitter/app-sdk/proposal-store";
import {agentDatabase} from "@ai-outfitter/app-sdk/cloudflare/database";
import {respond} from "@ai-outfitter/app-sdk/server";
import {workflowHost} from "@ai-outfitter/app-sdk/workflow-host";
import {z} from "zod";
import {context,run} from "./context";
import {saveInput,transitionInput,saveDocument,publishDocument} from "./store";
import type {Context} from "./graphql";

export function agentRoute(request:Request,operation:string,locals:unknown,internal=false){
 return respond(async()=>{
  if(import.meta.env.OUTFITTER_APP_MODE!=="operational")throw new Response("Read-only demo",{status:403});
  const ctx=context(request,locals);
  const reads=publishActionTools("wiki-map",{
   "documents.list":defineAction({description:"Read current Wiki documents and pages.",access:"read",input:z.strictObject({}),output:z.json(),run:(c:Context)=>run("WikiDocuments",{},c)}),
   "document.inspect":defineAction({description:"Read a document and its revision history before proposing changes.",access:"read",input:z.strictObject({id:z.string().min(1)}),output:z.json(),run:(c:Context,input)=>run("WikiDocument",input,c)}),
  });
  const actions=publishActionTools("wiki-map",{
   "document.save":defineAction({description:"Save an authored draft. Existing documents require the revision just read; published content remains intact.",access:"write",input:saveInput,output:z.json(),run:async(c:Context,input)=>{const saved=await saveDocument(c.database,c.identity,input);return {id:saved.id,revision:saved.revision};}}),
   "document.publish":defineAction({description:"Publish the exact document revision, subject to required approval providers.",access:"write",input:transitionInput,output:z.json(),run:async(c:Context,input)=>{const saved=await publishDocument(c.database,c.identity,input,c.policyCheck);return {id:saved.id,revision:saved.revision,publishedRevision:saved.publishedRevision};}}),
  });
  const agent=actionAgent({
   store:new ProposalStore(agentDatabase(),ctx.identity,{table:"wiki_map_proposals",guard:"wiki_map_agent_guard"}),
   host:workflowHost<"interactive">(locals as never),
   type:"wiki-map.conversation",contextType:"wiki-map.page",focusId:"e9500000-0000-4000-8000-000000000002",label:"wiki-map",
   context:()=>ctx,
   instructions:"You are the Wiki assistant. Help people read and revise documents. Read the current revision before preparing a change. Save changes as drafts and keep human-authored content intact. Publishing is a separate action subject to exact-revision policy checks; never claim publication means Governance approval. Canonical people, projects and relationships live in Onto: use its named GraphQL documents for graph questions and never recreate the graph inside Wiki. A reference grants no access. Existing conversation history is context, not current authority.",
   reads,actions:Object.fromEntries(Object.entries(actions).map(([name,action])=>[name,{action,retry:"inspect" as const,prepare:(input:unknown)=>input}])) ,
   routes:[{path:"",description:"Wiki documents and pages."},{path:"p/<slug>",description:"Read a saved page."},{path:"related",description:"People and projects from Onto."},{path:"new",description:"Create a document draft."}],
   page:async()=>({wiki:{installationId:ctx.identity.installationId},...(await run("WikiDocuments",{first:20},ctx))}),
  });
  return internal?agent.provider(request,operation):agent.browser(request,operation);
 });
}
