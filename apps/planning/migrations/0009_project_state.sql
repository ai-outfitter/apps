ALTER TABLE `planning_projects` ADD `state` text DEFAULT 'active' NOT NULL;
--> statement-breakpoint
UPDATE `planning_projects` SET `state` = 'archived' WHERE `archived` = 1;
