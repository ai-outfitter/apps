-- Onto schema. Schema only; initialization loads the standard JSON data.
CREATE TABLE graph_assertion_confirmations (
  assertionId text NOT NULL REFERENCES graph_nodes(id),
  assertionRevision integer NOT NULL,
  userId text NOT NULL,
  assertionHash text NOT NULL,
  subjectHash text NOT NULL,
  assertionBody text NOT NULL,
  subjectSnapshot text NOT NULL,
  confirmedAt integer NOT NULL,
  PRIMARY KEY (assertionId,assertionRevision,subjectHash,userId)
) STRICT;
--> statement-breakpoint
CREATE TABLE `graph_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`pageId` text NOT NULL,
	`key` text NOT NULL,
	`filename` text NOT NULL,
	`contentType` text NOT NULL,
	`size` integer NOT NULL,
	`createdBy` text,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`pageId`) REFERENCES `graph_nodes`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE TABLE `graph_batch_operations` (
	`batchId` text NOT NULL REFERENCES `graph_batches`(`id`),
	`ref` text NOT NULL,
	`position` integer NOT NULL,
	`operation` text NOT NULL,
	`evidence` text DEFAULT '[]' NOT NULL,
	`confidence` real,
	`reason` text,
	`state` text NOT NULL,
	`decidedBy` text,
	`decision` text,
	`recordId` text,
	`recordRevision` integer,
	PRIMARY KEY(`batchId`, `ref`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `graph_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`purpose` text DEFAULT '' NOT NULL,
	`source` text,
	`policy` text NOT NULL,
	`state` text NOT NULL,
	`summary` text,
	`openedBy` text NOT NULL,
	`openedVia` text NOT NULL,
	`reviewBy` integer,
	`commits` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`expiresAt` integer NOT NULL,
	`closedAt` integer
, `review` text, reviewJobId text, anchors text) STRICT;
--> statement-breakpoint
CREATE TABLE graph_change_receipts (
  actor TEXT NOT NULL,
  document TEXT NOT NULL,
  request_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  claim TEXT NOT NULL,
  result TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (actor, document, request_key)
) STRICT;
--> statement-breakpoint
CREATE TABLE graph_changes (
  userId TEXT NOT NULL,
  requestKey TEXT NOT NULL,
  hash TEXT NOT NULL,
  attempt TEXT NOT NULL,
  receipt TEXT NOT NULL,
  PRIMARY KEY (userId, requestKey)
) STRICT;
--> statement-breakpoint
CREATE TABLE `graph_edges` (
	`id` text PRIMARY KEY NOT NULL,
	`typeId` text NOT NULL,
	`fromId` text NOT NULL,
	`toId` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`properties` text DEFAULT '{}' NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`createdBy` text,
	`updatedBy` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`validFrom` text,
	`validTo` text,
	FOREIGN KEY (`typeId`) REFERENCES `graph_types`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`fromId`) REFERENCES `graph_nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`toId`) REFERENCES `graph_nodes`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE TABLE `graph_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`typeId` text NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`website` text,
	`properties` text DEFAULT '{}' NOT NULL,
	`source` text,
	`externalProvider` text,
	`externalId` text,
	`archived` integer DEFAULT false NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`createdBy` text,
	`updatedBy` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL, validity text,
	FOREIGN KEY (`typeId`) REFERENCES `graph_types`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE TABLE `graph_revisions` (
	`kind` text NOT NULL,
	`recordId` text NOT NULL,
	`revision` integer NOT NULL,
	`batchId` text,
	`ref` text,
	`proposedBy` text NOT NULL,
	`approval` text NOT NULL,
	`evidence` text DEFAULT '[]' NOT NULL,
	`snapshot` text NOT NULL,
	`prior` text,
	`createdAt` integer NOT NULL,
	PRIMARY KEY(`kind`, `recordId`, `revision`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `graph_types` (
	`id` text PRIMARY KEY NOT NULL,
	`category` text NOT NULL,
	`name` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`properties` text NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`seedVersion` integer,
	`revision` integer DEFAULT 1 NOT NULL,
	`createdBy` text,
	`updatedBy` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE onto_review_jobs (
  id text PRIMARY KEY NOT NULL,
  batchId text NOT NULL REFERENCES graph_batches(id),
  contentDigest text NOT NULL,
  state text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  leaseId text,
  leaseUntil integer,
  nextAttemptAt integer NOT NULL,
  createdAt integer NOT NULL,
  error text
) STRICT;
--> statement-breakpoint
CREATE TABLE `wiki_map_agent_guard` (
	`value` integer NOT NULL,
	CONSTRAINT "wiki_map_agent_atomic" CHECK("wiki_map_agent_guard"."value"=1)
) STRICT;
--> statement-breakpoint
CREATE TABLE `wiki_map_proposals` (
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
CREATE UNIQUE INDEX `graph_assets_key_unique` ON `graph_assets` (`key`);
--> statement-breakpoint
CREATE INDEX `graph_batches_state` ON `graph_batches` (`state`,`updatedAt`);
--> statement-breakpoint
-- One active edge per type, ends and start of validity.
CREATE UNIQUE INDEX graph_edges_identity ON graph_edges(typeId, fromId, toId, coalesce(validFrom, '')) WHERE archived = 0;
--> statement-breakpoint
CREATE INDEX graph_edges_out ON graph_edges(fromId, typeId, toId);
--> statement-breakpoint
CREATE INDEX graph_edges_in ON graph_edges(toId, typeId, fromId);
--> statement-breakpoint
-- An edge's ends must have the node types its edge type allows: a list of type ids
-- per side in the type's contract, or "any".
CREATE TRIGGER graph_edges_endpoints_insert BEFORE INSERT ON graph_edges
WHEN NOT EXISTS (
  SELECT 1 FROM graph_types e, graph_nodes f, graph_nodes t
  WHERE e.id = NEW.typeId AND f.id = NEW.fromId AND t.id = NEW.toId
    AND (json_extract(e.properties, '$.ontology.endpoints.from') = 'any'
      OR EXISTS (SELECT 1 FROM json_each(e.properties, '$.ontology.endpoints.from') WHERE value = f.typeId))
    AND (json_extract(e.properties, '$.ontology.endpoints.to') = 'any'
      OR EXISTS (SELECT 1 FROM json_each(e.properties, '$.ontology.endpoints.to') WHERE value = t.typeId))
)
BEGIN SELECT RAISE(ABORT, 'graph_edges: endpoint types not allowed by the edge type'); END;
--> statement-breakpoint
CREATE TRIGGER graph_edges_endpoints_update BEFORE UPDATE OF typeId, fromId, toId ON graph_edges
WHEN NOT EXISTS (
  SELECT 1 FROM graph_types e, graph_nodes f, graph_nodes t
  WHERE e.id = NEW.typeId AND f.id = NEW.fromId AND t.id = NEW.toId
    AND (json_extract(e.properties, '$.ontology.endpoints.from') = 'any'
      OR EXISTS (SELECT 1 FROM json_each(e.properties, '$.ontology.endpoints.from') WHERE value = f.typeId))
    AND (json_extract(e.properties, '$.ontology.endpoints.to') = 'any'
      OR EXISTS (SELECT 1 FROM json_each(e.properties, '$.ontology.endpoints.to') WHERE value = t.typeId))
)
BEGIN SELECT RAISE(ABORT, 'graph_edges: endpoint types not allowed by the edge type'); END;
--> statement-breakpoint
CREATE UNIQUE INDEX `graph_nodes_external_identity_idx` ON `graph_nodes` (`externalProvider`,`externalId`);
--> statement-breakpoint
CREATE UNIQUE INDEX graph_nodes_type_slug ON graph_nodes(typeId, slug);
--> statement-breakpoint
CREATE UNIQUE INDEX `graph_nodes_source_idx` ON `graph_nodes` (`source`);
--> statement-breakpoint
CREATE INDEX graph_nodes_source_record_idx ON graph_nodes(json_extract(source, '$.id')) WHERE source IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `graph_revisions_batch` ON `graph_revisions` (`batchId`);
--> statement-breakpoint
CREATE UNIQUE INDEX `graph_types_name_unique` ON `graph_types` (`name`);
--> statement-breakpoint
CREATE INDEX onto_review_jobs_due ON onto_review_jobs(state, nextAttemptAt, leaseUntil);
--> statement-breakpoint
CREATE INDEX `wiki_map_proposals_owner` ON `wiki_map_proposals` (`installationId`,`ownerId`,`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `wiki_map_proposals_request` ON `wiki_map_proposals` (`installationId`,`requestKey`);
--> statement-breakpoint
CREATE INDEX `wiki_map_proposals_thread` ON `wiki_map_proposals` (`installationId`,`threadId`);
