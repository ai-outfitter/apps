CREATE TABLE `foundry_evidence_publications` (
	`bundle` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`batchId` text NOT NULL,
	`documentId` text NOT NULL,
	`state` text NOT NULL,
	`createdBy` text NOT NULL,
	`createdAt` integer NOT NULL
) STRICT;
