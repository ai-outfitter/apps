CREATE TABLE `forerunner_items` (
	`id` text PRIMARY KEY NOT NULL,
	`installationId` text NOT NULL,
	`ownerId` text NOT NULL,
	`category` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`dueDate` text,
	`status` text DEFAULT 'todo' NOT NULL,
	`position` integer NOT NULL,
	`parentId` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`parentId`) REFERENCES `forerunner_items`(`id`) ON UPDATE no action ON DELETE restrict
) STRICT;
--> statement-breakpoint
CREATE INDEX `forerunner_owner_order` ON `forerunner_items` (`installationId`,`ownerId`,`category`,`position`);--> statement-breakpoint
CREATE INDEX `forerunner_parent` ON `forerunner_items` (`parentId`);