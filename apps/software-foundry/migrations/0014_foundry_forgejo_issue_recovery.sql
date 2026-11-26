DROP INDEX `foundry_forgejo_issue_review_target`;--> statement-breakpoint
ALTER TABLE `foundry_forgejo_issue_reviews` ADD `recoveryOf` text;--> statement-breakpoint
CREATE UNIQUE INDEX `foundry_forgejo_issue_recovery` ON `foundry_forgejo_issue_reviews` (`recoveryOf`);--> statement-breakpoint
CREATE UNIQUE INDEX `foundry_forgejo_issue_review_target` ON `foundry_forgejo_issue_reviews` (`installationId`,`forgeOrigin`,`repositoryId`,`issueNumber`) WHERE "foundry_forgejo_issue_reviews"."recoveryOf" is null;