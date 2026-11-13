CREATE TABLE `planning_design_partners` (
	`installationId` text NOT NULL,
	`organizationId` text NOT NULL,
	`name` text NOT NULL,
	`refreshedAt` integer NOT NULL,
	PRIMARY KEY(`installationId`, `organizationId`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `planning_partner_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`installationId` text NOT NULL,
	`partnerOrganizationId` text NOT NULL,
	`requestId` text NOT NULL,
	`submitter` text NOT NULL,
	`brief` text NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`reason` text,
	`foundryRequest` text,
	`decidedBy` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`createdBy` text NOT NULL,
	`updatedBy` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `planning_partner_requests_request` ON `planning_partner_requests` (`installationId`,`partnerOrganizationId`,`requestId`);
