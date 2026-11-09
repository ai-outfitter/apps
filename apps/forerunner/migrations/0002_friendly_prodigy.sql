CREATE TABLE `forerunner_discovery_records` (
	`id` text PRIMARY KEY NOT NULL,
	`installationId` text NOT NULL,
	`ownerId` text NOT NULL,
	`kind` text NOT NULL,
	`data` text NOT NULL,
	`createdAt` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX `forerunner_discovery_owner` ON `forerunner_discovery_records` (`installationId`,`ownerId`,`kind`);