-- What this graph shows another organization (server/graph-shares.ts): a saved
-- KnowledgeGraph walked from named roots, minus hidden nodes. Steps, never facts.
CREATE TABLE `graph_shares` (
	`slug` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`state` text NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`revision` integer NOT NULL,
	`createdBy` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedBy` text NOT NULL,
	`updatedAt` integer NOT NULL
) STRICT;
