-- Agents name change batches by slug, not UUID. Existing batches get a short slug from their id.
ALTER TABLE graph_batches ADD COLUMN slug TEXT;
--> statement-breakpoint
UPDATE graph_batches SET slug = 'batch-' || substr(id, 1, 8) || substr(id, 10, 4) WHERE slug IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX graph_batches_slug_idx ON graph_batches(slug);
