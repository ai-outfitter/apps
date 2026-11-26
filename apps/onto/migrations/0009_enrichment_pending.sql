CREATE UNIQUE INDEX IF NOT EXISTS onto_pending_enrichment_source
ON graph_batches(json_extract(source, '$.ref'))
WHERE state IN ('open', 'awaiting_review')
  AND json_extract(source, '$.kind') = 'agent-task'
  AND substr(json_extract(source, '$.ref'), 1, 11) = 'enrichment/';
