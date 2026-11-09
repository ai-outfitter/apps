CREATE TABLE `planning_issues` (
	`id` text PRIMARY KEY NOT NULL,
	`installationId` text NOT NULL,
	`projectId` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`category` text NOT NULL,
	`status` text DEFAULT 'todo' NOT NULL,
	`assigneeId` text,
	`dueDate` text,
	`position` integer NOT NULL,
	`parentId` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`createdBy` text NOT NULL,
	`updatedBy` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`projectId`) REFERENCES `planning_projects`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`parentId`) REFERENCES `planning_issues`(`id`) ON UPDATE no action ON DELETE restrict
) STRICT;
--> statement-breakpoint
CREATE INDEX `planning_issues_project_order` ON `planning_issues` (`installationId`,`projectId`,`category`,`position`);--> statement-breakpoint
CREATE INDEX `planning_issues_parent` ON `planning_issues` (`parentId`);--> statement-breakpoint
CREATE TABLE `planning_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`installationId` text NOT NULL,
	`name` text NOT NULL,
	`goals` text DEFAULT '' NOT NULL,
	`userStories` text DEFAULT '' NOT NULL,
	`pressRelease` text DEFAULT '' NOT NULL,
	`demoInstructions` text DEFAULT '' NOT NULL,
	`demoResults` text DEFAULT '' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`createdBy` text NOT NULL,
	`updatedBy` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX `planning_projects_installation` ON `planning_projects` (`installationId`);
--> statement-breakpoint
CREATE TRIGGER planning_project_limit BEFORE INSERT ON planning_projects BEGIN
 SELECT RAISE(ABORT,'planning_project_limit') WHERE (SELECT COUNT(*) FROM planning_projects WHERE installationId=NEW.installationId)>=100;
END;
--> statement-breakpoint
CREATE TRIGGER planning_issue_insert BEFORE INSERT ON planning_issues BEGIN
 SELECT RAISE(ABORT,'planning_project_scope') WHERE NOT EXISTS(SELECT 1 FROM planning_projects WHERE id=NEW.projectId AND installationId=NEW.installationId);
 SELECT RAISE(ABORT,'planning_parent_scope') WHERE NEW.parentId IS NOT NULL AND (NEW.parentId=NEW.id OR NOT EXISTS(SELECT 1 FROM planning_issues WHERE id=NEW.parentId AND installationId=NEW.installationId AND projectId=NEW.projectId));
 SELECT RAISE(ABORT,'planning_issue_limit') WHERE (SELECT COUNT(*) FROM planning_issues WHERE projectId=NEW.projectId)>=500;
 SELECT RAISE(ABORT,'planning_issue_values') WHERE NEW.category NOT IN ('stone','pebble','sand') OR NEW.status NOT IN ('todo','in-progress','done');
END;
--> statement-breakpoint
CREATE TRIGGER planning_issue_update BEFORE UPDATE ON planning_issues BEGIN
 SELECT RAISE(ABORT,'planning_project_scope') WHERE NEW.installationId<>OLD.installationId OR NOT EXISTS(SELECT 1 FROM planning_projects WHERE id=NEW.projectId AND installationId=NEW.installationId);
 SELECT RAISE(ABORT,'planning_children_scope') WHERE NEW.projectId<>OLD.projectId AND EXISTS(SELECT 1 FROM planning_issues WHERE parentId=OLD.id);
 SELECT RAISE(ABORT,'planning_parent_scope') WHERE NEW.parentId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM planning_issues WHERE id=NEW.parentId AND installationId=NEW.installationId AND projectId=NEW.projectId);
 SELECT RAISE(ABORT,'planning_parent_cycle') WHERE NEW.id=NEW.parentId OR NEW.id IN (WITH RECURSIVE ancestors(id,parentId) AS (SELECT id,parentId FROM planning_issues WHERE id=NEW.parentId UNION SELECT i.id,i.parentId FROM planning_issues i JOIN ancestors a ON i.id=a.parentId) SELECT id FROM ancestors);
 SELECT RAISE(ABORT,'planning_issue_limit') WHERE NEW.projectId<>OLD.projectId AND (SELECT COUNT(*) FROM planning_issues WHERE projectId=NEW.projectId)>=500;
 SELECT RAISE(ABORT,'planning_issue_values') WHERE NEW.category NOT IN ('stone','pebble','sand') OR NEW.status NOT IN ('todo','in-progress','done');
END;
