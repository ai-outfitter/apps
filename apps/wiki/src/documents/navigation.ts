import type { AgentDatabase } from "@ai-outfitter/app-sdk/agent-store";

export type NavigationPage = { id: string; slug: string; parentId: string | null; title: string };
export type TreeLink = NavigationPage & { depth: number };
/** Installation-local metadata only: document bodies and provenance never enter navigation. */
export async function navigationPages(db: AgentDatabase): Promise<NavigationPage[]> {
 return await db.query({sql: `WITH RECURSIVE metadata AS (
 SELECT p.id,p.slug,p.parentId,COALESCE(r.title,p.slug) AS title
 FROM wiki_pages p LEFT JOIN wiki_documents d ON d.id=p.documentId
 LEFT JOIN wiki_document_revisions r ON r.documentId=d.id AND r.revision=d.revision
 WHERE p.documentId IS NULL OR d.archived=0
 ), tree(id,slug,parentId,title,depth) AS (
 SELECT id,slug,parentId,title,0 FROM metadata WHERE parentId IS NULL AND (slug IN ('profile','notes') OR lower(title) IN ('profile','notes'))
 UNION ALL SELECT p.id,p.slug,p.parentId,p.title,t.depth+1 FROM metadata p JOIN tree t ON p.parentId=t.id WHERE t.depth<8
 ) SELECT id,slug,parentId,title FROM tree ORDER BY depth,slug LIMIT 500`}) as NavigationPage[];
}
export function documentTrees(pages: NavigationPage[]): TreeLink[] {
 const result: TreeLink[] = [], seen = new Set<string>();
 function append(page: NavigationPage, depth: number) {
  if(seen.has(page.id) || depth>8)return;
  seen.add(page.id); result.push({...page,depth});
  for(const child of pages.filter(value=>value.parentId===page.id))append(child,depth+1);
 }
 for(const name of ["profile","notes"]){
  const root=pages.find(page=>!page.parentId&&(page.slug===name||page.title.toLowerCase()===name));
  if(root)append(root,0);
 }
 return result;
}
export type RecentDocument = { id: string; title: string; summary: string; revision: number; updatedAt: number; slug: string };
export function recentCursor(params: URLSearchParams): {updatedAt: number; id: string} | undefined {
 const timestamp=params.get("before"),id=params.get("id");
 if(timestamp===null&&id===null)return;
 if(!timestamp||!/^\d{1,16}$/.test(timestamp)||!id||id.length>256||!Number.isSafeInteger(Number(timestamp)))throw new Response("Invalid recent documents cursor",{status:400});
 return {updatedAt:Number(timestamp),id};
}
export async function recentDocuments(db: AgentDatabase, cursor?: {updatedAt: number; id: string}): Promise<RecentDocument[]> {
 return await db.query({sql:`SELECT d.id,r.title,r.summary,d.revision,d.updatedAt,
 COALESCE((SELECT p.slug FROM wiki_pages p WHERE p.documentId=d.id ORDER BY p.slug LIMIT 1),d.id) AS slug
 FROM wiki_documents d JOIN wiki_document_revisions r ON r.documentId=d.id AND r.revision=d.revision
 WHERE d.archived=0 AND (d.updatedAt<? OR (d.updatedAt=? AND d.id<?))
 ORDER BY d.updatedAt DESC,d.id DESC LIMIT 51`,params:[cursor?.updatedAt??Number.MAX_SAFE_INTEGER,cursor?.updatedAt??Number.MAX_SAFE_INTEGER,cursor?.id??"\uffff"]}) as RecentDocument[];
}
export function relatedType(value: string | null): "Goal" | "Project" | "Person" | undefined {
 if(value===null)return;
 if(value!=="Goal"&&value!=="Project"&&value!=="Person")throw new Response("Unknown connected information type",{status:400});
 return value;
}
