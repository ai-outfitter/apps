CREATE TABLE `foundry_forgejo_issue_review_bindings` (
	`key` text PRIMARY KEY NOT NULL,
	`revision` text NOT NULL,
	`connectionId` text NOT NULL,
	`implementer` text NOT NULL,
	`reviewer` text NOT NULL,
	`reviewerName` text NOT NULL,
	`reviewerId` integer NOT NULL,
	`workerId` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `foundry_forgejo_issue_reviews` ADD `draftObservation` text;