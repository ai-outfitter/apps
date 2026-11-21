-- The graph cutover froze every source table, including the empty SDK file index.
-- Wiki now uses that index for page files. Keep the historical graph locks in place.
DROP TRIGGER IF EXISTS "_onto_cutover_app_storage_objects_INSERT";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "_onto_cutover_app_storage_objects_UPDATE";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "_onto_cutover_app_storage_objects_DELETE";
