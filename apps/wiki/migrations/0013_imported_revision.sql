-- Track the original imported head, even if Wiki edits preceded this upgrade.
ALTER TABLE wiki_documents ADD COLUMN importedRevision INTEGER;
--> statement-breakpoint
UPDATE wiki_documents SET importedRevision=(
 SELECT MIN(imported.revision) FROM wiki_document_revisions imported
 JOIN wiki_document_revisions head ON head.documentId=wiki_documents.id AND head.revision=wiki_documents.revision
 WHERE imported.documentId=wiki_documents.id AND imported.provenance=head.provenance
) WHERE legacyNodeId IS NOT NULL;
