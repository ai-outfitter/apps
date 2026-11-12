import { defineEntity, type EntityProvider } from "@ai-outfitter/app-sdk/entities";
import type { AgentDatabase } from "@ai-outfitter/app-sdk/agent-store";
import { requireAccess,type AppIdentity } from "@ai-outfitter/app-sdk/server";
import { z } from "zod";
import {getDocument,type Document} from "./store";

const fields=z.strictObject({title:z.string().max(300),summary:z.string().max(4000),body:z.string().max(200000),generatedBody:z.string().max(200000),publishedRevision:z.number().int().positive().nullable()});
function requireDocumentReader(identity:AppIdentity){
 requireAccess(identity,"read");
 if(identity.callerOrganizationId || identity.role.split(",").includes("external"))throw new Response("Document membership required",{status:403});
}
/** Read the canonical document store; entity references grant no additional visibility or writes. */
export function documentEntities(db:AgentDatabase):EntityProvider[]{
 return [defineEntity<Document,typeof fields>({
  type:"document",title:"Wiki document",description:"Current authorized Wiki draft, including authored and generated sections, at its exact revision. Read-only; saved/publication changes use the document contract.",schema:fields,
  can:(identity,operation)=>{requireDocumentReader(identity);return operation==="get"||operation==="list";},
  name:row=>row.title.slice(0,200),
  list:async(identity,offset,limit)=>{
   requireDocumentReader(identity);
   return await db.query({sql:"SELECT d.*,r.* FROM wiki_documents d JOIN wiki_document_revisions r ON r.documentId=d.id AND r.revision=d.revision WHERE d.archived=0 ORDER BY d.id LIMIT ? OFFSET ?",params:[limit,offset]}) as Document[];
  },
  get:async(identity,id)=>{
   requireDocumentReader(identity);const document=await getDocument(db,id);
   if(document.archived)throw new Response("Document not found",{status:404});
   return document;
  },
 })];
}
