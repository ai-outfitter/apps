import type {AgentDatabase} from "@ai-outfitter/app-sdk/agent-store";
/** Call only after the source graph cutover has been verified. Schema migration may
 * survive a failed activation, while the restored legacy Worker accepts more edits. */
export async function resumeLegacyImport(db:AgentDatabase) {
 const guard=crypto.randomUUID();
 const sources="FROM graph_nodes n JOIN graph_types t ON t.id=n.typeId WHERE t.name='Document'";
 try { await db.batch([
  {sql:`INSERT INTO wiki_write_guards(id,ok) SELECT ?,CASE WHEN NOT EXISTS (
    SELECT 1 FROM graph_nodes n JOIN graph_types t ON t.id=n.typeId JOIN wiki_documents d ON d.id=n.id
    WHERE t.name='Document' AND (d.legacyNodeId IS NOT n.id OR (n.revision>d.importedRevision AND (d.revision<>d.importedRevision OR d.publishedRevision IS NOT NULL)))
   ) THEN 1 ELSE 0 END`,params:[guard]},
  {sql:`INSERT OR IGNORE INTO wiki_documents(id,revision,archived,legacyNodeId,createdAt,updatedAt,importedRevision)
    SELECT n.id,n.revision,n.archived,n.id,n.createdAt,n.updatedAt,n.revision ${sources}`},
  {sql:`INSERT OR IGNORE INTO wiki_document_revisions(documentId,revision,title,summary,body,provenance,editorId,createdAt)
    SELECT r.recordId,r.revision,COALESCE(json_extract(r.snapshot,'$.title'),''),COALESCE(json_extract(r.snapshot,'$.summary'),''),COALESCE(json_extract(r.snapshot,'$.body'),''),
    json_object('kind','legacy-graph','snapshot',json(r.snapshot),'prior',CASE WHEN r.prior IS NULL THEN NULL ELSE json(r.prior) END,'approval',json(r.approval),'evidence',json(r.evidence),'batchId',r.batchId),r.proposedBy,r.createdAt
    FROM graph_revisions r JOIN wiki_documents d ON d.id=r.recordId WHERE r.kind='graph-node' AND d.legacyNodeId=r.recordId`},
  {sql:`INSERT OR IGNORE INTO wiki_document_revisions(documentId,revision,title,summary,body,provenance,editorId,createdAt)
    SELECT n.id,n.revision,n.title,n.summary,n.body,json_object('kind','legacy-head','nodeId',n.id),n.updatedBy,n.updatedAt ${sources}`},
  {sql:`UPDATE wiki_documents SET revision=(SELECT revision FROM graph_nodes WHERE id=legacyNodeId),importedRevision=(SELECT revision FROM graph_nodes WHERE id=legacyNodeId),updatedAt=(SELECT updatedAt FROM graph_nodes WHERE id=legacyNodeId),archived=(SELECT archived FROM graph_nodes WHERE id=legacyNodeId)
    WHERE legacyNodeId IS NOT NULL AND revision=importedRevision AND publishedRevision IS NULL AND importedRevision<(SELECT revision FROM graph_nodes WHERE id=legacyNodeId)`},
  {sql:`INSERT INTO wiki_pages(id,slug,documentId,updatedAt) SELECT n.id,n.slug,n.id,n.updatedAt ${sources} AND NOT EXISTS(SELECT 1 FROM wiki_pages p WHERE p.documentId=n.id)`},
  {sql:"DELETE FROM wiki_write_guards WHERE id=?",params:[guard]},
 ]); } catch(error) {
  if(String(error).includes("CHECK constraint failed"))throw new Response("Legacy document edits conflict with Wiki edits; reconcile before activating",{status:409});
  throw error;
 }
}
