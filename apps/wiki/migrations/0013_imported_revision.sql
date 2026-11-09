-- Track which head came from the legacy graph before any Wiki-authored edits.
ALTER TABLE wiki_documents ADD COLUMN importedRevision INTEGER;
--> statement-breakpoint
UPDATE wiki_documents SET importedRevision=revision WHERE legacyNodeId IS NOT NULL;
