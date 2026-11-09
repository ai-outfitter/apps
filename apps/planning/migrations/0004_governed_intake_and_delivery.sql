-- App-owned delivery and intake; preserve pre-rebase preview records if present.
CREATE TABLE IF NOT EXISTS `planning_work_evaluations` (
	`id` text PRIMARY KEY NOT NULL,
	`submissionId` text NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`submissionId`) REFERENCES `planning_work_submissions`(`id`) ON UPDATE no action ON DELETE restrict
) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `planning_work_guard` (
	`value` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `planning_work_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`installationId` text NOT NULL,
	`projectId` text NOT NULL,
	`actor` text NOT NULL,
	`request` text NOT NULL,
	`snapshot` text NOT NULL,
	`policy` text NOT NULL,
	`foundryReceipt` text,
	`observation` text,
	`review` text,
	`accepted` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`projectId`) REFERENCES `planning_projects`(`id`) ON UPDATE no action ON DELETE restrict
) STRICT;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `planning_intakes` (
	`id` text PRIMARY KEY NOT NULL,
	`installationId` text NOT NULL,
	`body` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`createdAt` integer NOT NULL
) STRICT;
