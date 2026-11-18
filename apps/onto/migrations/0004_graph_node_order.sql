-- GraphQL collection pages read one type in orderBy order with LIMIT (server/graph-source.ts).
CREATE INDEX `graph_nodes_type_id` ON `graph_nodes` (`typeId`,`id`);--> statement-breakpoint
CREATE INDEX `graph_nodes_type_created` ON `graph_nodes` (`typeId`,`createdAt`,`id`);--> statement-breakpoint
CREATE INDEX `graph_nodes_type_updated` ON `graph_nodes` (`typeId`,`updatedAt`,`id`);--> statement-breakpoint
CREATE INDEX `graph_nodes_type_title` ON `graph_nodes` (`typeId`,`title`,`id`);--> statement-breakpoint
-- A page over every node type (graph.query without types) has no type test: it reads in orderBy order from these.
CREATE INDEX `graph_nodes_created` ON `graph_nodes` (`createdAt`,`id`);--> statement-breakpoint
CREATE INDEX `graph_nodes_updated` ON `graph_nodes` (`updatedAt`,`id`);--> statement-breakpoint
CREATE INDEX `graph_nodes_title` ON `graph_nodes` (`title`,`id`);
