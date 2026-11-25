CREATE TABLE `foundry_plans` (
	`key` text PRIMARY KEY NOT NULL,
	`requestId` text NOT NULL,
	`runId` text NOT NULL,
	`digest` text NOT NULL,
	`repositoryGrants` text NOT NULL,
	`repositories` text NOT NULL,
	`anchorRepository` text,
	`issuePublisherId` integer,
	`state` text NOT NULL,
	`updatedAt` integer NOT NULL,
	`artifact` text,
	`issue` text,
	`message` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `foundry_plans_run_idx` ON `foundry_plans` (`runId`);