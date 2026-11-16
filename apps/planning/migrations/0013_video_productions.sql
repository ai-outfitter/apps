CREATE TABLE planning_video_productions (id TEXT NOT NULL, installationId TEXT NOT NULL, revision INTEGER NOT NULL, packet TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, PRIMARY KEY(installationId,id));
--> statement-breakpoint
CREATE TABLE planning_video_versions (id TEXT NOT NULL, installationId TEXT NOT NULL, revision INTEGER NOT NULL, packet TEXT NOT NULL, PRIMARY KEY(installationId,id,revision));
--> statement-breakpoint
CREATE TABLE planning_video_takes (id TEXT NOT NULL, installationId TEXT NOT NULL, productionId TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(installationId,id));
--> statement-breakpoint
CREATE TABLE planning_video_assets (id TEXT NOT NULL, installationId TEXT NOT NULL, productionId TEXT NOT NULL, body TEXT NOT NULL, ready INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(installationId,id));
