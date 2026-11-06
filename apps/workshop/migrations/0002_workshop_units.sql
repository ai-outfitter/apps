CREATE TABLE `workshop_units` (
	`id` text PRIMARY KEY NOT NULL,
	`partNumber` text NOT NULL,
	`mpn` text NOT NULL,
	`mac` text,
	`serial` text,
	`status` text NOT NULL,
	`location` text NOT NULL,
	`projectId` text,
	`firmware` text NOT NULL,
	`notes` text NOT NULL,
	`revision` integer NOT NULL,
	`createdBy` text NOT NULL,
	`updatedBy` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_units_mac_unique` ON `workshop_units` (`mac`);--> statement-breakpoint
CREATE INDEX `workshop_units_part_idx` ON `workshop_units` (`partNumber`);