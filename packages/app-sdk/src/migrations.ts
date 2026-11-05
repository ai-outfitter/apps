import { z } from "zod";

/** The table behind `@ai-outfitter/app-sdk/storage`, installed with the app's migrations. */
export { storageMigration } from "./storage";

// An app that keeps its own records ships its migrations in its package
// (catalog/apps/<slug>/migrations, docs/app-databases.md). Install and upgrade
// apply the missing ones to the installation's database before the new Worker
// is staged, so migrations must stay compatible with the previous app revision.

export const appMigration = z
  .object({
    name: z
      .string()
      .max(128)
      .regex(/^\d{4}_[a-z0-9_]+$/),
    sql: z.string().min(1).max(1024 * 1024),
  })
  .strict();
export type AppMigration = z.infer<typeof appMigration>;

/** Runs statements as one batch: all of them apply, or none do. */
export type AppDatabaseExecutor = {
  query(sql: string): Promise<Record<string, unknown>[]>;
  batch(statements: string[]): Promise<void>;
};

export const migrationLedger = "_outfitter_migrations";
const ledger = migrationLedger;

export function migrationStatements(sql: string) {
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim().replace(/;$/, ""))
    .filter(Boolean);
}

/** Applies missing migrations in name order; returns the names it applied. */
export async function migrateAppDatabase(
  database: AppDatabaseExecutor,
  migrations: AppMigration[],
) {
  await database.batch([
    `CREATE TABLE IF NOT EXISTS ${ledger} (name TEXT PRIMARY KEY NOT NULL, appliedAt INTEGER NOT NULL) STRICT`,
  ]);
  const applied = new Set(
    (await database.query(`SELECT name FROM ${ledger}`)).map((row) =>
      String(row.name),
    ),
  );
  const missing = migrations
    .map((migration) => appMigration.parse(migration))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .filter((migration) => !applied.has(migration.name));
  for (const migration of missing)
    await database.batch([
      ...migrationStatements(migration.sql),
      // appMigration admits only [0-9a-z_] names, so this needs no quoting.
      `INSERT INTO ${ledger} (name, appliedAt) VALUES ('${migration.name}', ${Date.now()})`,
    ]);
  return missing.map((migration) => migration.name);
}
