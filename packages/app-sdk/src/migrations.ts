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

/** Optional fresh-install schema; existing ledgers always continue legacy migrations. */
export const appMigrationBaseline = appMigration.extend({
  replaces: z.array(appMigration.shape.name).min(1).max(1000),
});
export type AppMigrationBaseline = z.infer<typeof appMigrationBaseline>;

/** Validate the complete immutable lineage before running any SQL. */
export function validateMigrationLineage(migrations: AppMigration[], baselines: AppMigrationBaseline[] = []) {
  const legacy = migrations.map(migration => appMigration.parse(migration));
  const fresh = baselines.map(baseline => appMigrationBaseline.parse(baseline));
  const names = new Set<string>(), covered = new Set<string>();
  for (const migration of legacy) {
    if (names.has(migration.name)) throw new Error(`Duplicate migration ${migration.name}`);
    names.add(migration.name);
  }
  const baselineNames = new Set<string>();
  for (const baseline of fresh) {
    if (names.has(baseline.name) || baselineNames.has(baseline.name)) throw new Error(`Duplicate baseline ${baseline.name}`);
    baselineNames.add(baseline.name);
    for (const name of baseline.replaces) {
      if (!names.has(name)) throw new Error(`Unknown baseline replacement ${name}`);
      if (covered.has(name)) throw new Error(`Duplicate baseline replacement ${name}`);
      covered.add(name);
    }
  }
  return { migrations: legacy.sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0), baselines: fresh.sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) };
}

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

/** Apply a baseline only when none of its legacy migrations has run.
 * Baseline SQL and all covered ledger rows commit atomically. Existing/partial
 * ledgers keep their original SQL lineage. Hosts must explicitly pass baseline
 * metadata; older callers using two arguments retain legacy behavior. */
export async function migrateAppDatabase(
  database: AppDatabaseExecutor,
  migrations: AppMigration[],
  baselines: AppMigrationBaseline[] = [],
) {
  const lineage = validateMigrationLineage(migrations, baselines);
  await database.batch([
    `CREATE TABLE IF NOT EXISTS ${ledger} (name TEXT PRIMARY KEY NOT NULL, appliedAt INTEGER NOT NULL) STRICT`,
  ]);
  const applied = new Set(
    (await database.query(`SELECT name FROM ${ledger}`)).map(row => String(row.name)),
  );
  const ran: string[] = [];
  for (const baseline of lineage.baselines) {
    if (applied.has(baseline.name)) {
      if (baseline.replaces.some(name => !applied.has(name))) throw new Error("Incomplete baseline ledger");
      continue;
    }
    if (baseline.replaces.some(name => applied.has(name))) continue;
    const names = [baseline.name, ...baseline.replaces];
    await database.batch([
      ...migrationStatements(baseline.sql),
      ...names.map(name => `INSERT INTO ${ledger} (name, appliedAt) VALUES ('${name}', ${Date.now()})`),
    ]);
    for (const name of names) applied.add(name);
    ran.push(baseline.name);
  }
  for (const migration of lineage.migrations) {
    if (applied.has(migration.name)) continue;
    await database.batch([
      ...migrationStatements(migration.sql),
      `INSERT INTO ${ledger} (name, appliedAt) VALUES ('${migration.name}', ${Date.now()})`,
    ]);
    applied.add(migration.name);
    ran.push(migration.name);
  }
  return ran;
}
