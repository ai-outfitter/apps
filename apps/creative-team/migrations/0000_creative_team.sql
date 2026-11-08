CREATE TABLE `brand_answers` (
	`id` text PRIMARY KEY NOT NULL,
	`answer` text DEFAULT '' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updatedBy` text,
	`updatedAt` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `content_profile` (
	`id` text PRIMARY KEY NOT NULL,
	`coreIdeas` text DEFAULT '' NOT NULL,
	`voice` text DEFAULT '' NOT NULL,
	`worldview` text DEFAULT '' NOT NULL,
	`patterns` text DEFAULT '' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updatedBy` text,
	`updatedAt` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`nodeId` text,
	`format` text NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updatedBy` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	CONSTRAINT "drafts_status_check" CHECK("drafts"."status" IN ('draft', 'ready', 'posted', 'archived'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `drafts_status_idx` ON `drafts` (`status`,`updatedAt`);--> statement-breakpoint
CREATE TABLE `graph_change_receipts` (
	`actor` text NOT NULL,
	`document` text NOT NULL,
	`request_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`claim` text NOT NULL,
	`result` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`actor`, `document`, `request_key`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `map_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`parentId` text,
	`level` text NOT NULL,
	`title` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`research` text DEFAULT '' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updatedBy` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	CONSTRAINT "map_nodes_level_check" CHECK("map_nodes"."level" IN ('pillar', 'topic', 'idea', 'angle'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `map_nodes_parent_idx` ON `map_nodes` (`parentId`,`position`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`platform` text DEFAULT '' NOT NULL,
	`handle` text DEFAULT '' NOT NULL,
	`url` text DEFAULT '' NOT NULL,
	`examples` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updatedBy` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	CONSTRAINT "sources_kind_check" CHECK("sources"."kind" IN ('own', 'influence'))
) STRICT;
