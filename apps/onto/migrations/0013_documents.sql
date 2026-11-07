CREATE TABLE document_definitions (owner TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, definition TEXT NOT NULL, PRIMARY KEY(owner,id,version));
--> statement-breakpoint
CREATE TABLE document_heads (owner TEXT NOT NULL, id TEXT NOT NULL, definition_id TEXT NOT NULL, definition_version INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0, latest_job TEXT, PRIMARY KEY(owner,id));
--> statement-breakpoint
CREATE TABLE document_jobs (owner TEXT NOT NULL, id TEXT NOT NULL, document_id TEXT NOT NULL, definition_version INTEGER NOT NULL, base_revision INTEGER NOT NULL, state TEXT NOT NULL, lease_token TEXT, lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, PRIMARY KEY(owner,id));
--> statement-breakpoint
CREATE TABLE document_revisions (owner TEXT NOT NULL, document_id TEXT NOT NULL, revision INTEGER NOT NULL, definition_id TEXT NOT NULL, definition_version INTEGER NOT NULL, digest TEXT NOT NULL, payload TEXT NOT NULL, capture TEXT NOT NULL, complete INTEGER NOT NULL, PRIMARY KEY(owner,document_id,revision));
--> statement-breakpoint
CREATE TABLE document_seals (owner TEXT NOT NULL, document_id TEXT NOT NULL, revision INTEGER NOT NULL, digest TEXT NOT NULL, sealed_at INTEGER NOT NULL, PRIMARY KEY(owner,document_id,revision));
--> statement-breakpoint
CREATE TABLE document_events (owner TEXT NOT NULL, id TEXT NOT NULL, binding TEXT NOT NULL, state TEXT NOT NULL, result TEXT, lease_token TEXT, lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, PRIMARY KEY(owner,id));
--> statement-breakpoint
CREATE TABLE document_guards (id TEXT PRIMARY KEY, ok INTEGER NOT NULL CHECK(ok=1));
--> statement-breakpoint
CREATE TABLE document_runs (owner TEXT NOT NULL, run_id TEXT NOT NULL, job_id TEXT NOT NULL, PRIMARY KEY(owner,run_id));
