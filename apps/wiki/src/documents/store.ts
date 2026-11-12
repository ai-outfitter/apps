import { z } from "zod";
import type { AgentDatabase, AgentStatement } from "@ai-outfitter/app-sdk/agent-store";
import { requireAccess, requireEditor, type AppIdentity } from "@ai-outfitter/app-sdk/server";
import { entityRef } from "@ai-outfitter/app-sdk/entities";

export type DocumentHead = { id: string; revision: number; publishedRevision: number | null; archived: number; legacyNodeId: string | null; createdAt: number; updatedAt: number };
export type DocumentRevision = { documentId: string; revision: number; title: string; summary: string; body: string; generatedBody: string; provenance: string | null; editorId: string | null; createdAt: number };
export type Document = DocumentHead & DocumentRevision;
export type Page = { id: string; slug: string; documentId: string | null; entityRef: string | null; parentId: string | null; revision: number; autoPublish: number; policyRef: string | null; updatedAt: number };
const id = z.string().min(1).max(256);
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,199}$/);
export const saveInput = z.strictObject({
 id: id.optional(), revision: z.number().int().positive().optional(),
 title: z.string().trim().min(1).max(300), summary: z.string().max(4000).default(""), body: z.string().max(200000).default(""),
 slug: slug.optional(),
});
export const pageInput = z.strictObject({
 id: id.optional(), revision: z.number().int().positive().optional(), slug,
 documentId: id.nullable().default(null), entityRef: entityRef.nullable().default(null),
 parentId: id.nullable().default(null), autoPublish: z.boolean().default(false), policyRef: entityRef.nullable().default(null),
}).refine(value => value.documentId || value.entityRef, "A page needs a document or an entity");
export const transitionInput = z.strictObject({ id, revision: z.number().int().positive() });
const stmt = (sql: string, ...params: unknown[]): AgentStatement => ({ sql, params });
const conflict = () => new Response("Document changed; refresh and review the current revision", {status: 409});
export async function listDocuments(db: AgentDatabase, after = "", limit = 50): Promise<Document[]> {
 return await db.query(stmt(`SELECT d.*,r.* FROM wiki_documents d JOIN wiki_document_revisions r ON r.documentId=d.id AND r.revision=d.revision WHERE d.archived=0 AND d.id>? ORDER BY d.id LIMIT ?`,after,Math.max(1,Math.min(limit,100)))) as Document[];
}
export async function getDocument(db: AgentDatabase, documentId: string, revision?: number): Promise<Document> {
 const rows = await db.query(stmt(`SELECT d.*,r.* FROM wiki_documents d JOIN wiki_document_revisions r ON r.documentId=d.id AND r.revision=COALESCE(?,d.revision) WHERE d.id=?`, revision ?? null,documentId));
 if (!rows[0]) throw new Response("Document not found",{status:404});
 return rows[0] as Document;
}
export async function revisions(db: AgentDatabase, documentId: string, before = Number.MAX_SAFE_INTEGER): Promise<DocumentRevision[]> {
 return await db.query(stmt("SELECT * FROM wiki_document_revisions WHERE documentId=? AND revision<? ORDER BY revision DESC LIMIT 100",documentId,before)) as DocumentRevision[];
}
export async function listPages(db: AgentDatabase): Promise<Page[]> {
 return await db.query(stmt("SELECT * FROM wiki_pages ORDER BY slug LIMIT 500")) as Page[];
}
export async function getPage(db:AgentDatabase,slugOrId:string):Promise<Page> {
 const rows=await db.query(stmt("SELECT * FROM wiki_pages WHERE slug=? OR documentId=? OR id=? ORDER BY CASE WHEN slug=? THEN 0 ELSE 1 END LIMIT 1",slugOrId,slugOrId,slugOrId,slugOrId));
 if(!rows[0])throw new Response("Page not found",{status:404});
 return rows[0] as Page;
}
async function guarded(db: AgentDatabase, sql: string, params: unknown[], writes: AgentStatement[]) {
 const token=crypto.randomUUID();
 try { await db.batch([
  stmt(`INSERT INTO wiki_write_guards(id,ok) SELECT ?,CASE WHEN (${sql}) THEN 1 ELSE 0 END`,token,...params),
  ...writes,stmt("DELETE FROM wiki_write_guards WHERE id=?",token),
 ]); } catch(error) {
  if (String(error).includes("CHECK constraint failed")) throw conflict();
  throw error;
 }
}
export async function saveDocument(db: AgentDatabase, who: AppIdentity, raw: z.input<typeof saveInput>): Promise<Document> {
 requireEditor(who);
 const input=saveInput.parse(raw), now=Date.now();
 if (!input.id) {
  if(input.revision) throw new Response("New documents have no revision",{status:400});
  const documentId=crypto.randomUUID();
  await db.batch([
   stmt("INSERT INTO wiki_documents(id,revision,createdAt,updatedAt) VALUES(?,1,?,?)",documentId,now,now),
   stmt("INSERT INTO wiki_document_revisions(documentId,revision,title,summary,body,editorId,createdAt) VALUES(?,1,?,?,?,?,?)",documentId,input.title,input.summary,input.body,who.userId,now),
   stmt("INSERT INTO wiki_pages(id,slug,documentId,updatedAt) VALUES(?,?,?,?)",crypto.randomUUID(),input.slug ?? documentId,documentId,now),
  ]);
  return getDocument(db,documentId);
 }
 const current=await getDocument(db,input.id);
 if(input.revision!==current.revision || current.archived) throw conflict();
 await guarded(db,"SELECT count(*)=1 FROM wiki_documents WHERE id=? AND revision=? AND archived=0",[input.id,input.revision],[
  stmt("INSERT INTO wiki_document_revisions(documentId,revision,title,summary,body,generatedBody,provenance,editorId,createdAt) VALUES(?,?,?,?,?,?,?,?,?)",input.id,current.revision+1,input.title,input.summary,input.body,current.generatedBody,current.provenance,who.userId,now),
  stmt("UPDATE wiki_documents SET revision=revision+1,updatedAt=? WHERE id=?",now,input.id),
 ]);
 return getDocument(db,input.id);
}
export async function savePage(db: AgentDatabase, who: AppIdentity, raw: z.input<typeof pageInput>): Promise<Page> {
 requireEditor(who); const input=pageInput.parse(raw), pageId=input.id ?? crypto.randomUUID(), now=Date.now();
 if(input.documentId) await getDocument(db,input.documentId);
 const parents=await listPages(db);
 const existing=parents.find(page=>page.id===pageId);
 if(input.policyRef || input.autoPublish || existing?.policyRef || existing?.autoPublish) requireAccess(who,"admin");
 let parent=input.parentId; const seen=new Set([pageId]);
 while(parent) { if(seen.has(parent)) throw new Response("Page hierarchy contains a cycle",{status:400}); seen.add(parent); const row=parents.find(p=>p.id===parent); if(!row) throw new Response("Parent page not found",{status:404}); parent=row.parentId; }
 const values=[input.slug,input.documentId,input.entityRef ? JSON.stringify(input.entityRef):null,input.parentId,Number(input.autoPublish),input.policyRef ? JSON.stringify(input.policyRef):null,now];
 if(input.id) await guarded(db,"SELECT count(*)=1 FROM wiki_pages WHERE id=? AND revision=?",[input.id,input.revision ?? 0],[stmt("UPDATE wiki_pages SET slug=?,documentId=?,entityRef=?,parentId=?,autoPublish=?,policyRef=?,updatedAt=?,revision=revision+1 WHERE id=?",...values,pageId)]);
 else await db.batch([stmt("INSERT INTO wiki_pages(slug,documentId,entityRef,parentId,autoPublish,policyRef,updatedAt,id) VALUES(?,?,?,?,?,?,?,?)",...values,pageId)]);
 return (await db.query(stmt("SELECT * FROM wiki_pages WHERE id=?",pageId)))[0] as Page;
}
export async function archiveDocument(db: AgentDatabase, who: AppIdentity, input: z.input<typeof transitionInput>) {
 requireEditor(who); const value=transitionInput.parse(input);
 await guarded(db,"SELECT count(*)=1 FROM wiki_documents WHERE id=? AND revision=?",[value.id,value.revision],[stmt("UPDATE wiki_documents SET archived=1,updatedAt=? WHERE id=?",Date.now(),value.id)]);
 return getDocument(db,value.id);
}
/** A page policy is authoritative: its provider must approve this exact revision. */
export type PolicyCheck = (policy: z.infer<typeof entityRef>, subject: {installationId:string;documentId:string;revision:number;digest:string}) => Promise<{allowed:boolean;revision:number;digest:string}>;
export async function documentDigest(document: DocumentRevision) {
 const hash=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify([document.documentId,document.revision,document.title,document.summary,document.body,document.generatedBody])));
 return [...new Uint8Array(hash)].map(v=>v.toString(16).padStart(2,"0")).join("");
}
export async function publishDocument(db: AgentDatabase, who: AppIdentity, raw: z.input<typeof transitionInput>, check?: PolicyCheck) {
 requireEditor(who); const input=transitionInput.parse(raw), current=await getDocument(db,input.id);
 if(current.revision!==input.revision || current.archived) throw conflict();
 const digest=await documentDigest(current);
 const pages=await db.query(stmt("SELECT * FROM wiki_pages WHERE documentId=?",input.id)) as Page[];
 const decisions:unknown[]=[];
 for(const page of pages) if(page.policyRef) {
  if(!check) throw new Response("Required approval provider unavailable",{status:409});
  const result=await check(entityRef.parse(JSON.parse(page.policyRef)),{installationId:who.installationId,documentId:input.id,revision:input.revision,digest});
  if(!result.allowed || result.revision!==input.revision || result.digest!==digest) throw new Response("This document revision requires approval",{status:409});
  decisions.push({policy:JSON.parse(page.policyRef),result});
 }
 // Bind publication to the page policy configuration that was evaluated too.
 await guarded(db,"SELECT count(*)=1 FROM wiki_documents WHERE id=? AND revision=? AND archived=0 AND (SELECT COALESCE(json_group_array(json_array(id,revision,policyRef)),'[]') FROM (SELECT id,revision,policyRef FROM wiki_pages WHERE documentId=? ORDER BY id))=?",[input.id,input.revision,input.id,JSON.stringify(pages.sort((a,b)=>a.id.localeCompare(b.id)).map(p=>[p.id,p.revision,p.policyRef]))],[
  stmt("INSERT INTO wiki_publications(id,documentId,revision,digest,publishedBy,policies,createdAt) VALUES(?,?,?,?,?,?,?)",crypto.randomUUID(),input.id,input.revision,digest,who.userId,JSON.stringify(decisions),Date.now()),
  stmt("UPDATE wiki_documents SET publishedRevision=?,updatedAt=? WHERE id=?",input.revision,Date.now(),input.id),
 ]);
 return getDocument(db,input.id);
}

export const generatedInput = z.strictObject({
 id:id.optional(),revision:z.number().int().positive().optional(),slug:slug.optional(),title:z.string().trim().min(1).max(300).optional(),
 generatedBody: z.string().max(200000), provenance: z.record(z.string(),z.json()),
}).superRefine((value,context)=>{
 if(value.id ? !value.revision || value.slug!==undefined || value.title!==undefined : !value.slug || !value.title || value.revision!==undefined)context.addIssue({code:"custom",message:"Use id/revision to update, or slug/title to create a generated draft"});
});
/** Replace only a generated section at the exact draft revision; preserve authored and published content. */
export async function saveGeneratedDocument(db:AgentDatabase,who:AppIdentity,raw:z.input<typeof generatedInput>):Promise<Document>{
 requireEditor(who);
 const input=generatedInput.parse(raw),now=Date.now();
 if(!input.id){
  const documentId=crypto.randomUUID();
  await db.batch([
   stmt("INSERT INTO wiki_documents(id,revision,createdAt,updatedAt) VALUES(?,1,?,?)",documentId,now,now),
   stmt("INSERT INTO wiki_document_revisions(documentId,revision,title,summary,body,generatedBody,provenance,editorId,createdAt) VALUES(?,1,?,'','',?,?,?,?)",documentId,input.title,input.generatedBody,JSON.stringify(input.provenance),who.userId,now),
   stmt("INSERT INTO wiki_pages(id,slug,documentId,updatedAt) VALUES(?,?,?,?)",crypto.randomUUID(),input.slug,documentId,now),
  ]);
  return getDocument(db,documentId);
 }
 const current=await getDocument(db,input.id);
 if(current.revision!==input.revision || current.archived)throw conflict();
 const provenance=JSON.stringify(input.provenance);
 if(current.generatedBody===input.generatedBody && current.provenance===provenance)return current;
 await guarded(db,"SELECT count(*)=1 FROM wiki_documents WHERE id=? AND revision=? AND archived=0",[input.id,input.revision],[
  stmt("INSERT INTO wiki_document_revisions(documentId,revision,title,summary,body,generatedBody,provenance,editorId,createdAt) VALUES(?,?,?,?,?,?,?,?,?)",input.id,current.revision+1,current.title,current.summary,current.body,input.generatedBody,provenance,who.userId,now),
  stmt("UPDATE wiki_documents SET revision=revision+1,updatedAt=? WHERE id=?",now,input.id),
 ]);
 return getDocument(db,input.id);
}
