-- Typed neighbour hops (graph.context) answer from the index alone: an edge's
-- type and far endpoint sit beside the near endpoint, so a traversal step never
-- reads edge rows. Active nodes by type serve anchor and context lookups.
CREATE INDEX IF NOT EXISTS graph_edges_from_typed_idx ON graph_edges(fromId, typeId, toId) WHERE archived = 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS graph_edges_to_typed_idx ON graph_edges(toId, typeId, fromId) WHERE archived = 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS graph_nodes_active_type_idx ON graph_nodes(typeId) WHERE archived = 0;
