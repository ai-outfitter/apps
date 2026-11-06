CREATE TABLE IF NOT EXISTS `foundry_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`repositories` text DEFAULT '[]' NOT NULL,
	`milestones` text DEFAULT '[]' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`createdBy` text,
	`updatedBy` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `foundry_projects_name_idx` ON `foundry_projects` (`name`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `foundry_projects_position_idx` ON `foundry_projects` (`position`);