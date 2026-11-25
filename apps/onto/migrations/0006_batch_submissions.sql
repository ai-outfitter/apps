ALTER TABLE graph_batches ADD COLUMN submittedVersion INTEGER NOT NULL DEFAULT 0;
CREATE TABLE graph_batch_submissions (
  batchId TEXT NOT NULL REFERENCES graph_batches(id),
  version INTEGER NOT NULL,
  at INTEGER NOT NULL,
  author TEXT NOT NULL,
  via TEXT NOT NULL,
  proposals TEXT NOT NULL,
  PRIMARY KEY (batchId, version)
) STRICT;
