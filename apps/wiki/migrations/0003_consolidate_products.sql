-- Semantic data migration: retain node identities, authored content and all edges.
-- Keep the archived definition for provenance; fresh setup no longer seeds it.
UPDATE graph_nodes
SET typeId = '71000000-0000-4000-8000-000000000015',
    revision = revision + 1,
    updatedBy = 'migration:consolidate-products',
    updatedAt = unixepoch() * 1000
WHERE typeId = '71000000-0000-4000-8000-000000000008';
--> statement-breakpoint
UPDATE graph_nodes
SET properties = json_set(properties, '$.root_type',
      CASE trim(json_extract(properties, '$.root_type'), char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))
        WHEN 'SoftwareProduct' THEN 'Product'
        ELSE '71000000-0000-4000-8000-000000000015'
      END),
    revision = revision + 1,
    updatedBy = 'migration:consolidate-products',
    updatedAt = unixepoch() * 1000
WHERE typeId = '71000000-0000-4000-8000-000000000066'
  AND trim(json_extract(properties, '$.root_type'), char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)) IN
    ('SoftwareProduct', '71000000-0000-4000-8000-000000000008');
--> statement-breakpoint
UPDATE graph_types
SET archived = 1,
    revision = revision + 1,
    updatedBy = 'migration:consolidate-products',
    updatedAt = unixepoch() * 1000
WHERE id = '71000000-0000-4000-8000-000000000008' AND archived = 0;
