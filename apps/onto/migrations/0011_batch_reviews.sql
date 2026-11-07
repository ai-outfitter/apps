-- The ontology steward's latest advisory review of a submitted batch
-- (server/batch-review.ts). Each review is a batch-review workflow run, whose
-- logs are the audit trail; this column keeps the newest findings and run ID.
ALTER TABLE `graph_batches` ADD `review` text;
