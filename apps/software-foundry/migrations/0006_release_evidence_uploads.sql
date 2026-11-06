CREATE TABLE `foundry_release_evidence_uploads` (
	`key` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`installationId` text NOT NULL,
	`createdBy` text NOT NULL,
	`actor` text NOT NULL,
	`originActor` text NOT NULL,
	`bundle` text NOT NULL,
	`path` text NOT NULL,
	`metadata` text NOT NULL,
	`fingerprint` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`createdAt` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `foundry_evidence_upload_token` ON `foundry_release_evidence_uploads` (`token`);--> statement-breakpoint
CREATE UNIQUE INDEX `foundry_evidence_upload_target` ON `foundry_release_evidence_uploads` (`bundle`,`path`);