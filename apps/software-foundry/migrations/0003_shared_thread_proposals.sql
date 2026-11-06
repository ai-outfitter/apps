-- Unknown states or orphaned receipts require inspection; never silently discard them.
INSERT INTO software_foundry_agent_guard(value) SELECT 0 FROM software_foundry_agent_proposals p LEFT JOIN software_foundry_agent_conversations c ON c.id=p.conversationId WHERE p.status NOT IN ('pending','applied','rejected','cancelled','executing','unconfirmed','uncertain') OR c.id IS NULL;
--> statement-breakpoint
DELETE FROM software_foundry_agent_guard;
--> statement-breakpoint
-- Shared threads own conversations and turns. Keep all domain decision receipts.
CREATE TABLE `software_foundry_proposals` (
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
	`status` text DEFAULT 'pending' NOT NULL,
	`data` text NOT NULL,
	`receipt` text,
	`decidedBy` text,
	`timelineEntryId` text,
	`createdAt` integer,
	`updatedAt` integer
) STRICT;

--> statement-breakpoint
CREATE UNIQUE INDEX `software_foundry_proposals_request` ON `software_foundry_proposals` (`installationId`,`requestKey`);
--> statement-breakpoint
CREATE INDEX `software_foundry_proposals_thread` ON `software_foundry_proposals` (`installationId`,`threadId`);
--> statement-breakpoint
CREATE INDEX `software_foundry_proposals_owner` ON `software_foundry_proposals` (`installationId`,`ownerId`,`status`);
--> statement-breakpoint
INSERT INTO software_foundry_proposals (id,installationId,ownerId,threadId,requestKey,payloadDigest,action,revision,status,data,receipt,timelineEntryId) SELECT p.id,c.installationId,c.ownerId,'legacy:'||c.id,'legacy:'||p.id,'',COALESCE(json_extract(p.data,'$.action'),'unknown'),p.revision,CASE WHEN p.status='pending' THEN 'cancelled' WHEN p.status IN ('executing','unconfirmed','uncertain') THEN 'uncertain' ELSE p.status END,p.data,CASE WHEN p.status='pending' THEN '{"cancelled":true,"reason":"conversation history reset"}' ELSE p.receipt END,'legacy' FROM software_foundry_agent_proposals p JOIN software_foundry_agent_conversations c ON c.id=p.conversationId;
--> statement-breakpoint
DROP TABLE software_foundry_agent_proposals;
--> statement-breakpoint
DROP TABLE software_foundry_agent_turns;
--> statement-breakpoint
DROP TABLE software_foundry_agent_conversations;
