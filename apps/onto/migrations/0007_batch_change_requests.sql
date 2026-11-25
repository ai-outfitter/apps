CREATE TABLE graph_batch_change_requests (
  id TEXT PRIMARY KEY NOT NULL,
  batchId TEXT NOT NULL REFERENCES graph_batches(id),
  refs TEXT NOT NULL,
  decision TEXT NOT NULL
);
CREATE INDEX graph_batch_change_requests_batch ON graph_batch_change_requests(batchId);
