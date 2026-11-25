CREATE TABLE onto_passage_indexes (
 organizationId TEXT NOT NULL,
 wikiInstallationId TEXT NOT NULL,
 cursor TEXT,
 sweeps INTEGER NOT NULL DEFAULT 0,
 leaseId TEXT,
 leaseUntil INTEGER,
 updatedAt INTEGER NOT NULL,
 lastError TEXT,
 reportRunId TEXT,
 report TEXT CHECK (report IS NULL OR json_valid(report)),
 reportCollected INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY (organizationId, wikiInstallationId)
) STRICT;
--> statement-breakpoint
CREATE TABLE onto_passage_sources (
 organizationId TEXT NOT NULL,
 wikiInstallationId TEXT NOT NULL,
 sourceId TEXT NOT NULL,
 version TEXT NOT NULL,
 source TEXT NOT NULL CHECK (json_valid(source)),
 seen INTEGER NOT NULL,
 state TEXT NOT NULL CHECK (state IN ('pending','indexed','archived')),
 issue TEXT,
 attempts INTEGER NOT NULL DEFAULT 0,
 retryAt INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY (organizationId, wikiInstallationId, sourceId)
) STRICT;
--> statement-breakpoint
CREATE INDEX onto_passage_source_queue ON onto_passage_sources(organizationId,wikiInstallationId,state,retryAt,sourceId);
--> statement-breakpoint
CREATE TABLE onto_passages (
 id TEXT PRIMARY KEY,
 organizationId TEXT NOT NULL,
 wikiInstallationId TEXT NOT NULL,
 sourceId TEXT NOT NULL,
 version TEXT NOT NULL,
 text TEXT NOT NULL,
 searchText TEXT NOT NULL,
 locator TEXT NOT NULL CHECK (json_valid(locator)),
 inferred INTEGER NOT NULL DEFAULT 0,
 attempts INTEGER NOT NULL DEFAULT 0,
 retryAt INTEGER NOT NULL DEFAULT 0
) STRICT;
--> statement-breakpoint
CREATE INDEX onto_passages_search ON onto_passages(organizationId,wikiInstallationId,id);
--> statement-breakpoint
CREATE INDEX onto_passages_source ON onto_passages(organizationId,wikiInstallationId,sourceId,version);
--> statement-breakpoint
CREATE INDEX onto_passages_inference ON onto_passages(organizationId,wikiInstallationId,inferred,retryAt,id);
--> statement-breakpoint
CREATE TABLE onto_passage_suggestions (
 id TEXT PRIMARY KEY,
 organizationId TEXT NOT NULL,
 wikiInstallationId TEXT NOT NULL,
 sourceId TEXT NOT NULL,
 version TEXT NOT NULL,
 passageId TEXT NOT NULL,
 plan TEXT NOT NULL CHECK (json_valid(plan)),
 state TEXT NOT NULL CHECK (state IN ('pending','routed','unresolved','superseded')),
 issue TEXT,
 batchId TEXT UNIQUE,
 attempts INTEGER NOT NULL DEFAULT 0,
 retryAt INTEGER NOT NULL DEFAULT 0
) STRICT;
--> statement-breakpoint
CREATE INDEX onto_passage_suggestion_queue ON onto_passage_suggestions(organizationId,wikiInstallationId,state,retryAt,id);
--> statement-breakpoint
CREATE INDEX onto_passage_suggestion_source ON onto_passage_suggestions(organizationId,wikiInstallationId,sourceId,version);
