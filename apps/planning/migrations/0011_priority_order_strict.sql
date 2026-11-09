CREATE TABLE `planning_priority_order_strict` (`installationId` text NOT NULL, `kind` text NOT NULL, `items` text NOT NULL DEFAULT '[]', `revision` integer NOT NULL DEFAULT 1, PRIMARY KEY (`installationId`,`kind`)) STRICT;
--> statement-breakpoint
INSERT INTO `planning_priority_order_strict` (`installationId`, `kind`, `items`, `revision`) SELECT `installationId`, `kind`, `items`, `revision` FROM `planning_priority_order`;
--> statement-breakpoint
DROP TABLE `planning_priority_order`;
--> statement-breakpoint
ALTER TABLE `planning_priority_order_strict` RENAME TO `planning_priority_order`;
