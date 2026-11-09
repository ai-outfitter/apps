CREATE TABLE `planning_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`installationId` text NOT NULL,
	`ownerId` text NOT NULL,
	`threadId` text NOT NULL,
	`turnId` text,
	`requestKey` text NOT NULL,
	`payloadDigest` text NOT NULL,
	`action` text NOT NULL,
	`projectId` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL CHECK(`status` IN ('pending','applied','rejected','cancelled','uncertain')),
	`data` text NOT NULL,
	`receipt` text,
	`decidedBy` text,
	`timelineEntryId` text,
	`createdAt` integer,
	`updatedAt` integer
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `planning_proposals_request` ON `planning_proposals` (`installationId`,`requestKey`);--> statement-breakpoint
CREATE INDEX `planning_proposals_thread` ON `planning_proposals` (`installationId`,`threadId`);--> statement-breakpoint
CREATE INDEX `planning_proposals_owner` ON `planning_proposals` (`installationId`,`ownerId`,`status`);--> statement-breakpoint
-- Keep every decision receipt. Legacy app-local transcripts are discarded:
-- genuinely pending (never executed) drafts are cancelled; applied and rejected
-- receipts survive unchanged; executing/unconfirmed/uncertain outcomes become
-- `uncertain` with their original data and receipt. No timestamps are invented.
INSERT INTO `planning_proposals` (`id`,`installationId`,`ownerId`,`threadId`,`requestKey`,`payloadDigest`,`action`,`projectId`,`revision`,`status`,`data`,`receipt`,`timelineEntryId`)
SELECT p.`id`, c.`installationId`, c.`ownerId`, 'legacy:' || c.`id`, 'legacy:' || p.`id`, '', COALESCE(json_extract(p.`data`,'$.action'),'unknown'), json_extract(p.`data`,'$.projectId'), p.`revision`,
 CASE WHEN p.`status` IN ('applied','rejected') THEN p.`status` WHEN p.`status`='pending' THEN 'cancelled' ELSE 'uncertain' END, p.`data`,
 CASE WHEN p.`status`='pending' THEN '{"cancelled":true,"reason":"conversation history reset"}' ELSE p.`receipt` END,
 'legacy'
FROM `planning_agent_proposals` p JOIN `planning_agent_conversations` c ON c.`id` = p.`conversationId`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `planning_agent_project_cleanup`;--> statement-breakpoint
DROP TABLE `planning_agent_proposals`;--> statement-breakpoint
DROP TABLE `planning_agent_turns`;--> statement-breakpoint
DROP TABLE `planning_agent_conversations`;--> statement-breakpoint
-- Deleting a project cancels its still-pending proposals; decided receipts remain.
CREATE TRIGGER planning_proposals_project_cleanup AFTER DELETE ON planning_projects BEGIN
 UPDATE planning_proposals SET status='cancelled', receipt='{"cancelled":true,"reason":"project deleted"}' WHERE installationId=OLD.installationId AND projectId=OLD.id AND status='pending';
END;
