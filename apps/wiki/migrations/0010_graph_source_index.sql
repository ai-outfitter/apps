-- A page's canonical source record (`source` JSON: installation, type, id) is looked up
-- by graph.query's `sources` filter; the record id is the selective part, so the lookup
-- answers from this expression index instead of scanning every page.
CREATE INDEX IF NOT EXISTS graph_nodes_source_record_idx ON graph_nodes(json_extract(source, '$.id')) WHERE source IS NOT NULL;
