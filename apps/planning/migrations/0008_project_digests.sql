CREATE TABLE `planning_digests` (
	`id` text PRIMARY KEY NOT NULL,
	`installationId` text NOT NULL,
	`projectId` text NOT NULL,
	`runId` text,
	`trigger` text NOT NULL,
	`since` integer,
	`changes` text NOT NULL,
	`snapshot` text NOT NULL,
	`summary` text,
	`summaryError` text,
	`createdBy` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`projectId`) REFERENCES `planning_projects`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE INDEX `planning_digests_project` ON `planning_digests` (`installationId`,`projectId`,`createdAt`);