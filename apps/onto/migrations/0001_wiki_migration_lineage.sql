-- Trusted operator restores record provenance separately from editable graph data.
CREATE TABLE onto_wiki_migrations (
  id TEXT PRIMARY KEY NOT NULL,
  sourceInstallationId TEXT NOT NULL,
  destinationInstallationId TEXT NOT NULL,
  ownerKind TEXT NOT NULL,
  ownerId TEXT NOT NULL,
  sourceDigest TEXT NOT NULL,
  reconciliation TEXT NOT NULL,
  verification TEXT NOT NULL,
  actor TEXT NOT NULL,
  createdAt INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE onto_wiki_migration_sources (
  migrationId TEXT NOT NULL REFERENCES onto_wiki_migrations(id),
  tableName TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  row TEXT NOT NULL,
  PRIMARY KEY(migrationId, tableName, ordinal)
) STRICT;
