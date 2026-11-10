ALTER TABLE `foundry_requests` DROP COLUMN `triage`;--> statement-breakpoint
ALTER TABLE `foundry_requests` DROP COLUMN `record_id`;--> statement-breakpoint
ALTER TABLE `foundry_requests` ADD `issue_url` text;
