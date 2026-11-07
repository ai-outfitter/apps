-- Server-private authorities. These rows are not graph entities or portable imports.
CREATE TABLE onto_source_definitions (
  owner TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL,
  definition TEXT NOT NULL, digest TEXT NOT NULL, installation_id TEXT NOT NULL,
  PRIMARY KEY(owner,id,version)
);
--> statement-breakpoint
CREATE TABLE onto_source_proofs (
  owner TEXT NOT NULL, id TEXT NOT NULL, actor TEXT NOT NULL,
  request_key TEXT NOT NULL, request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','issued')),
  proof TEXT NOT NULL, digest TEXT NOT NULL, graph_request TEXT NOT NULL,
  PRIMARY KEY(owner,id), UNIQUE(owner,actor,request_key)
);
--> statement-breakpoint
CREATE TABLE onto_source_fences (
  owner TEXT NOT NULL, idempotency_key TEXT NOT NULL, actor TEXT NOT NULL,
  request_hash TEXT NOT NULL, proof_id TEXT NOT NULL, graph_request TEXT NOT NULL,
  receipt_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','sealed','conflict')),
  result TEXT, error TEXT,
  PRIMARY KEY(owner,idempotency_key)
);
