CREATE TABLE graph_change_receipts (
  actor TEXT NOT NULL,
  document TEXT NOT NULL,
  request_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  claim TEXT NOT NULL,
  result TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (actor, document, request_key)
) STRICT;
