CREATE TABLE IF NOT EXISTS `workshop_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`revision` integer NOT NULL,
	`data` text NOT NULL,
	`createdBy` text NOT NULL,
	`updatedBy` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `workshop_projects_updated_idx` ON `workshop_projects` (`updatedAt`);