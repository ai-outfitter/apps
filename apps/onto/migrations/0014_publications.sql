CREATE TABLE document_publications (
  owner TEXT NOT NULL,
  id TEXT NOT NULL,
  binding TEXT NOT NULL,
  state TEXT NOT NULL,
  commit_receipt TEXT,
  pull_receipt TEXT,
  error TEXT,
  PRIMARY KEY(owner,id)
);
