CREATE TABLE `foundry_forgejo_issue_reviews` (
	`runId` text PRIMARY KEY NOT NULL,
	`repositoryId` integer NOT NULL,
	`forgeOrigin` text NOT NULL,
	`issueNumber` integer NOT NULL,
	`installationId` text NOT NULL,
	`createdBy` text NOT NULL,
	`inputs` text NOT NULL,
	`branchClaim` text,
	`commitClaim` text,
	`publication` text,
	`candidate` text,
	`reviewPublication` text,
	`review` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `foundry_forgejo_issue_review_target` ON `foundry_forgejo_issue_reviews` (`installationId`,`forgeOrigin`,`repositoryId`,`issueNumber`);