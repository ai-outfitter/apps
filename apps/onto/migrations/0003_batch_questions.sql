-- Questions an agent asks on a batch (server/graph-batches.ts); they close with the batch.
ALTER TABLE `graph_batches` ADD `questions` text;
