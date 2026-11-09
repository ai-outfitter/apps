CREATE TABLE `planning_delivery_packages` (
	`id` text PRIMARY KEY NOT NULL,
	`installationId` text NOT NULL,
	`projectId` text NOT NULL,
	`target` text NOT NULL,
	`sequence` integer NOT NULL,
	`preparationId` text NOT NULL,
	`digest` text NOT NULL,
	`state` text NOT NULL,
	`body` text NOT NULL,
	`receipt` text,
	`supersedes` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`projectId`) REFERENCES `planning_projects`(`id`) ON UPDATE no action ON DELETE restrict
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `planning_delivery_packages_digest` ON `planning_delivery_packages` (`installationId`,`projectId`,`target`,`digest`);--> statement-breakpoint
CREATE UNIQUE INDEX `planning_delivery_packages_sequence` ON `planning_delivery_packages` (`installationId`,`projectId`,`target`,`sequence`);--> statement-breakpoint
CREATE TABLE `planning_preparations` (
	`id` text PRIMARY KEY NOT NULL,
	`installationId` text NOT NULL,
	`projectId` text NOT NULL,
	`projectRevision` integer NOT NULL,
	`state` text NOT NULL,
	`changes` text NOT NULL,
	`dispatchError` text,
	`plan` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`createdBy` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`projectId`) REFERENCES `planning_projects`(`id`) ON UPDATE no action ON DELETE restrict
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `planning_preparations_revision` ON `planning_preparations` (`installationId`,`projectId`,`projectRevision`);--> statement-breakpoint
CREATE TABLE `planning_requirement_revisions` (
	`requirementId` text NOT NULL,
	`revision` integer NOT NULL,
	`projectRevision` integer NOT NULL,
	`retired` integer DEFAULT false NOT NULL,
	`body` text NOT NULL,
	`actionDigest` text NOT NULL,
	`createdBy` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`requirementId`) REFERENCES `planning_requirements`(`id`) ON UPDATE no action ON DELETE restrict
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `planning_requirement_revisions_pk` ON `planning_requirement_revisions` (`requirementId`,`revision`);--> statement-breakpoint
CREATE TABLE `planning_requirements` (
	`id` text PRIMARY KEY NOT NULL,
	`installationId` text NOT NULL,
	`projectId` text NOT NULL,
	`key` text NOT NULL,
	`retired` integer DEFAULT false NOT NULL,
	`body` text NOT NULL,
	`actionDigest` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`createdBy` text NOT NULL,
	`updatedBy` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`projectId`) REFERENCES `planning_projects`(`id`) ON UPDATE no action ON DELETE restrict
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `planning_requirements_key` ON `planning_requirements` (`installationId`,`projectId`,`key`);