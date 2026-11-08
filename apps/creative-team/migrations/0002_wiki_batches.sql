CREATE TABLE `wiki_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`wikiInstallationId` text NOT NULL,
	`wikiPath` text NOT NULL,
	`state` text NOT NULL,
	`proposals` integer NOT NULL,
	`createdBy` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX `wiki_batches_created_idx` ON `wiki_batches` (`createdAt`);