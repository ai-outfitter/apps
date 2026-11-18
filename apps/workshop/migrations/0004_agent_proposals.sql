CREATE TABLE workshop_agent_guard (value INTEGER NOT NULL CHECK(value = 1)) STRICT;
--> statement-breakpoint
CREATE TABLE workshop_proposals (
  id TEXT PRIMARY KEY NOT NULL, installationId TEXT NOT NULL, ownerId TEXT NOT NULL,
  threadId TEXT NOT NULL, turnId TEXT, requestKey TEXT NOT NULL, payloadDigest TEXT NOT NULL,
  action TEXT NOT NULL, projectId TEXT, revision INTEGER DEFAULT 1 NOT NULL,
  status TEXT DEFAULT 'pending' NOT NULL, data TEXT NOT NULL, receipt TEXT, decidedBy TEXT,
  timelineEntryId TEXT, createdAt INTEGER, updatedAt INTEGER
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX workshop_proposals_request ON workshop_proposals (installationId, requestKey);
--> statement-breakpoint
CREATE INDEX workshop_proposals_thread ON workshop_proposals (installationId, threadId);
--> statement-breakpoint
CREATE INDEX workshop_proposals_owner ON workshop_proposals (installationId, ownerId, status);
