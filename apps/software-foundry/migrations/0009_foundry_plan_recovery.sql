ALTER TABLE `foundry_plans` ADD `actorDigest` text;--> statement-breakpoint
ALTER TABLE `foundry_plans` ADD `failureCode` text;--> statement-breakpoint
ALTER TABLE `foundry_plans` ADD `failedAttempts` text DEFAULT '[]' NOT NULL;