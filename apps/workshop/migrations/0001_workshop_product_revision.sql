ALTER TABLE `workshop_projects` ADD `wikiInstallationId` text;--> statement-breakpoint
ALTER TABLE `workshop_projects` ADD `productRevisionId` text;--> statement-breakpoint
ALTER TABLE `workshop_projects` ADD `productRevisionTitle` text;--> statement-breakpoint
CREATE INDEX `workshop_projects_product_revision_idx` ON `workshop_projects` (`productRevisionId`);