-- Wiki change batches (docs/plans/wiki-change-batches.md): staged operations
-- stay invisible to every read until committed. History rows record each
-- committed revision with its batch, evidence and approval.
CREATE TABLE `graph_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`purpose` text DEFAULT '' NOT NULL,
	`source` text,
	`policy` text NOT NULL,
	`state` text NOT NULL,
	`summary` text,
	`openedBy` text NOT NULL,
	`openedVia` text NOT NULL,
	`reviewBy` integer,
	`commits` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`expiresAt` integer NOT NULL,
	`closedAt` integer
) STRICT;
--> statement-breakpoint
CREATE INDEX `graph_batches_state` ON `graph_batches` (`state`,`updatedAt`);
--> statement-breakpoint
CREATE TABLE `graph_batch_operations` (
	`batchId` text NOT NULL REFERENCES `graph_batches`(`id`),
	`ref` text NOT NULL,
	`position` integer NOT NULL,
	`operation` text NOT NULL,
	`evidence` text DEFAULT '[]' NOT NULL,
	`confidence` real,
	`reason` text,
	`state` text NOT NULL,
	`decidedBy` text,
	`decision` text,
	`recordId` text,
	`recordRevision` integer,
	PRIMARY KEY(`batchId`, `ref`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `graph_revisions` (
	`kind` text NOT NULL,
	`recordId` text NOT NULL,
	`revision` integer NOT NULL,
	`batchId` text,
	`ref` text,
	`proposedBy` text NOT NULL,
	`approval` text NOT NULL,
	`evidence` text DEFAULT '[]' NOT NULL,
	`snapshot` text NOT NULL,
	`prior` text,
	`createdAt` integer NOT NULL,
	PRIMARY KEY(`kind`, `recordId`, `revision`)
) STRICT;
--> statement-breakpoint
CREATE INDEX `graph_revisions_batch` ON `graph_revisions` (`batchId`);
