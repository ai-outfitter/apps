CREATE TABLE creative_team_agent_guard (value INTEGER NOT NULL CHECK(value = 1)) STRICT;
--> statement-breakpoint
CREATE TABLE creative_team_proposals (
  id TEXT PRIMARY KEY NOT NULL, installationId TEXT NOT NULL, ownerId TEXT NOT NULL,
  threadId TEXT NOT NULL, turnId TEXT, requestKey TEXT NOT NULL, payloadDigest TEXT NOT NULL,
  action TEXT NOT NULL, projectId TEXT, revision INTEGER DEFAULT 1 NOT NULL,
  status TEXT DEFAULT 'pending' NOT NULL, data TEXT NOT NULL, receipt TEXT, decidedBy TEXT,
  timelineEntryId TEXT, createdAt INTEGER, updatedAt INTEGER
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX creative_team_proposals_request ON creative_team_proposals (installationId, requestKey);
--> statement-breakpoint
CREATE INDEX creative_team_proposals_thread ON creative_team_proposals (installationId, threadId);
--> statement-breakpoint
CREATE INDEX creative_team_proposals_owner ON creative_team_proposals (installationId, ownerId, status);
