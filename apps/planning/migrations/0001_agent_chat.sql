CREATE TABLE `planning_agent_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`installationId` text NOT NULL,
	`ownerId` text NOT NULL,
	`focusId` text NOT NULL,
	`messages` text DEFAULT '[]' NOT NULL,
	`activeTurn` text,
	`leaseUntil` integer DEFAULT 0 NOT NULL,
	`updatedAt` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `planning_agent_scope` ON `planning_agent_conversations` (`installationId`,`ownerId`,`focusId`);--> statement-breakpoint
CREATE TABLE `planning_agent_guard` (
	`value` integer NOT NULL,
	CONSTRAINT "planning_agent_atomic" CHECK("planning_agent_guard"."value"=1)
) STRICT;
--> statement-breakpoint
CREATE TABLE `planning_agent_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`conversationId` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`data` text NOT NULL,
	`receipt` text,
	FOREIGN KEY (`conversationId`) REFERENCES `planning_agent_conversations`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE TABLE `planning_agent_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`conversationId` text NOT NULL,
	`status` text NOT NULL,
	`text` text NOT NULL,
	FOREIGN KEY (`conversationId`) REFERENCES `planning_agent_conversations`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;

--> statement-breakpoint
CREATE TRIGGER planning_agent_project_cleanup AFTER DELETE ON planning_projects BEGIN
 DELETE FROM planning_agent_conversations WHERE installationId=OLD.installationId AND focusId=OLD.id;
END;
