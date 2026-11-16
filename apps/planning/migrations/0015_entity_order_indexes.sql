-- Entity list pages read one installation's rows in an advertised order then ID, after a keyset cursor (server/entities.ts).
CREATE INDEX `planning_projects_installation_id` ON `planning_projects` (`installationId`,`id`);--> statement-breakpoint
CREATE INDEX `planning_projects_installation_name` ON `planning_projects` (`installationId`,`name`,`id`);--> statement-breakpoint
CREATE INDEX `planning_issues_installation_id` ON `planning_issues` (`installationId`,`id`);--> statement-breakpoint
CREATE INDEX `planning_issues_installation_position` ON `planning_issues` (`installationId`,`position`,`id`);
