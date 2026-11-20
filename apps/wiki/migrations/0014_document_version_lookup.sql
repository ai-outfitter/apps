CREATE INDEX wiki_revisions_series_version ON wiki_document_revisions (
  json_extract(provenance,'$.kind'),
  coalesce(json_extract(provenance,'$.version'),json_extract(provenance,'$.date')) DESC,
  createdAt DESC
);
--> statement-breakpoint
CREATE INDEX wiki_pages_document_slug ON wiki_pages(documentId,slug);
