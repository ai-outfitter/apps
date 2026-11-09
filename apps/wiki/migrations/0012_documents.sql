-- Forward-only document ownership. The old graph and its ledgers stay intact.
CREATE TABLE wiki_documents (
 id TEXT PRIMARY KEY NOT NULL,
 revision INTEGER NOT NULL,
 publishedRevision INTEGER,
 archived INTEGER NOT NULL DEFAULT 0,
 legacyNodeId TEXT UNIQUE,
 createdAt INTEGER NOT NULL,
 updatedAt INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE wiki_document_revisions (
 documentId TEXT NOT NULL REFERENCES wiki_documents(id),
 revision INTEGER NOT NULL,
 title TEXT NOT NULL,
 summary TEXT NOT NULL DEFAULT '',
 body TEXT NOT NULL DEFAULT '',
 generatedBody TEXT NOT NULL DEFAULT '',
 provenance TEXT,
 editorId TEXT,
 createdAt INTEGER NOT NULL,
 PRIMARY KEY(documentId, revision)
) STRICT;
--> statement-breakpoint
CREATE TABLE wiki_pages (
 id TEXT PRIMARY KEY NOT NULL,
 slug TEXT NOT NULL UNIQUE,
 documentId TEXT REFERENCES wiki_documents(id),
 entityRef TEXT,
 parentId TEXT REFERENCES wiki_pages(id),
 revision INTEGER NOT NULL DEFAULT 1,
 autoPublish INTEGER NOT NULL DEFAULT 0,
 policyRef TEXT,
 updatedAt INTEGER NOT NULL,
 CHECK(documentId IS NOT NULL OR entityRef IS NOT NULL)
) STRICT;
--> statement-breakpoint
CREATE TABLE wiki_write_guards (id TEXT PRIMARY KEY NOT NULL, ok INTEGER NOT NULL CHECK(ok = 1)) STRICT;
--> statement-breakpoint
INSERT INTO wiki_documents(id,revision,archived,legacyNodeId,createdAt,updatedAt)
 SELECT n.id,n.revision,n.archived,n.id,n.createdAt,n.updatedAt
 FROM graph_nodes n JOIN graph_types t ON t.id=n.typeId WHERE t.name='Document';
--> statement-breakpoint
-- Preserve each captured revision, including its original approval/evidence.
INSERT INTO wiki_document_revisions(documentId,revision,title,summary,body,provenance,editorId,createdAt)
 SELECT r.recordId,r.revision,COALESCE(json_extract(r.snapshot,'$.title'),''),
 COALESCE(json_extract(r.snapshot,'$.summary'),''),COALESCE(json_extract(r.snapshot,'$.body'),''),
 json_object('kind','legacy-graph','snapshot',json(r.snapshot),'prior',CASE WHEN r.prior IS NULL THEN NULL ELSE json(r.prior) END,'approval',json(r.approval),'evidence',json(r.evidence),'batchId',r.batchId),r.proposedBy,r.createdAt
 FROM graph_revisions r JOIN wiki_documents d ON d.id=r.recordId WHERE r.kind='graph-node';
--> statement-breakpoint
-- Older direct writes did not always record a graph revision; retain the head too.
INSERT OR IGNORE INTO wiki_document_revisions(documentId,revision,title,summary,body,provenance,editorId,createdAt)
 SELECT n.id,n.revision,n.title,n.summary,n.body,json_object('kind','legacy-head','nodeId',n.id),n.updatedBy,n.updatedAt
 FROM graph_nodes n JOIN wiki_documents d ON d.id=n.id;
--> statement-breakpoint
INSERT INTO wiki_pages(id,slug,documentId,updatedAt)
 SELECT n.id,n.slug,n.id,n.updatedAt FROM graph_nodes n JOIN wiki_documents d ON d.id=n.id;
--> statement-breakpoint
CREATE TRIGGER wiki_revisions_no_update BEFORE UPDATE ON wiki_document_revisions BEGIN SELECT RAISE(ABORT,'Document revisions are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER wiki_revisions_no_delete BEFORE DELETE ON wiki_document_revisions BEGIN SELECT RAISE(ABORT,'Document revisions are immutable'); END;
--> statement-breakpoint
CREATE TABLE wiki_publications (
 id TEXT PRIMARY KEY NOT NULL,
 documentId TEXT NOT NULL,
 revision INTEGER NOT NULL,
 digest TEXT NOT NULL,
 publishedBy TEXT NOT NULL,
 policies TEXT NOT NULL,
 createdAt INTEGER NOT NULL,
 FOREIGN KEY(documentId,revision) REFERENCES wiki_document_revisions(documentId,revision)
) STRICT;
--> statement-breakpoint
CREATE TRIGGER wiki_publications_no_update BEFORE UPDATE ON wiki_publications BEGIN SELECT RAISE(ABORT,'Publication receipts are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER wiki_publications_no_delete BEFORE DELETE ON wiki_publications BEGIN SELECT RAISE(ABORT,'Publication receipts are immutable'); END;
