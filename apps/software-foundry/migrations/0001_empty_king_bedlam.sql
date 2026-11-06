CREATE TABLE `work_submissions` (
	`key` text PRIMARY KEY NOT NULL,
	`requestId` text NOT NULL,
	`payloadDigest` text NOT NULL,
	`payload` text NOT NULL,
	`repository` text NOT NULL,
	`issue` text,
	`createdAt` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX `work_submissions_request_idx` ON `work_submissions` (`requestId`);