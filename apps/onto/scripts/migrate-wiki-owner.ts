/** One explicitly authorized owner, using installation-bound operator access. */
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { migrationStatements } from "@ai-outfitter/app-sdk/migrations";
import { reconcileWiki } from "./reconcile-wiki";
import { importOldWiki } from "./import-old-wiki";
import {
  snapshotD1,
  materializeSnapshot,
  candidateSnapshot,
  addDestinationSeeds,
  addLineage,
  stageCandidate,
  promotionStatements,
  verifyTables,
  lockStatements,
  unlockStatements,
  finishUnlockStatements,
  sealLineage,
  tableDigests,
  type D1,
  type Snapshot,
} from "./wiki-migration-d1";
type Installation = { id: string; databaseId: string };
export type MigrationOwner = {
  owner: { kind: "user" | "organization"; id: string };
  source: Installation;
  destination: Installation;
  actor: string;
  directory: string;
  expectedDestination: Snapshot;
  verifyAuthority: () => Promise<void>;
  verifyAppRead: () => Promise<void>;
};
function unchangedSeedDestination(expected: Snapshot, actual: Snapshot) {
  for (const table of actual.tables) {
    const before = expected.tables.find((t) => t.name === table.name);
    if (!before && table.rows.length)
      throw Error(
        `Destination acquired data outside the captured seed baseline: ${table.name}`,
      );
  }
  verifyTables(expected, actual);
}
export async function migrateWikiOwner(d1: D1, input: MigrationOwner) {
  if (
    input.source.id === input.destination.id ||
    input.source.databaseId === input.destination.databaseId
  )
    throw Error(
      "Source and destination must be distinct installations and databases",
    );
  await input.verifyAuthority();
  await mkdir(input.directory, { mode: 0o700 });
  const save = async (name: string, value: unknown) =>
    writeFile(
      join(input.directory, name + ".local.json"),
      JSON.stringify(value, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
  const id = randomUUID();
  const initialSource = await snapshotD1(d1, input.source.databaseId);
  const initialDestination = await snapshotD1(d1, input.destination.databaseId);
  unchangedSeedDestination(input.expectedDestination, initialDestination);
  for (const s of [initialSource, initialDestination])
    for (const table of s.tables)
      if (
        ["graph_assets", "app_storage_objects"].includes(table.name) &&
        table.rows.length
      )
        throw Error("Binary assets need a verified storage transfer");
  await save("installation-proof", {
    id,
    owner: input.owner,
    source: input.source,
    destination: input.destination,
    actor: input.actor,
  });
  const sourceTables = initialSource.tables.map((t) => t.name),
    destinationTables = initialDestination.tables.map((t) => t.name);
  let sourceLocked = false,
    destinationLocked = false,
    promotionAttempted = false,
    finalized = false;
  try {
    await d1.query(
      input.source.databaseId,
      lockStatements(
        sourceTables,
        `Wiki graph migrated to Onto installation ${input.destination.id}`,
      ),
    );
    sourceLocked = true;
    await d1.query(
      input.destination.databaseId,
      lockStatements(destinationTables, "Onto migration in progress"),
    );
    destinationLocked = true;
    await input.verifyAuthority();
    const source = await snapshotD1(d1, input.source.databaseId),
      destination = await snapshotD1(d1, input.destination.databaseId);
    unchangedSeedDestination(input.expectedDestination, destination);
    await save("source-before", source);
    await save("destination-before", destination);
    const sourcePath = join(input.directory, "source.sqlite"),
      candidatePath = join(input.directory, "candidate.sqlite");
    materializeSnapshot(source, sourcePath);
    const db = new DatabaseSync(sourcePath, { readOnly: true });
    let reconciliation;
    try {
      reconciliation = reconcileWiki(db, input.actor);
    } finally {
      db.close();
    }
    await save("reconciliation", reconciliation);
    const converted = importOldWiki(sourcePath, candidatePath, reconciliation);
    addDestinationSeeds(candidatePath, destination, reconciliation.seedAliases);
    addLineage(
      candidatePath,
      {
        id,
        sourceInstallationId: input.source.id,
        destinationInstallationId: input.destination.id,
        owner: input.owner,
        sourceDigest: reconciliation.sourceDigest,
        reconciliation,
        actor: input.actor,
      },
      source,
    );
    const candidate = candidateSnapshot(candidatePath);
    // Every source history row remains byte-for-byte present alongside new contract revisions.
    for (const table of source.tables.filter(
      (t) => !["graph_types", "graph_nodes", "graph_edges"].includes(t.name),
    )) {
      const migrated = candidate.tables.find((t) => t.name === table.name);
      if (!migrated) {
        if (table.rows.length)
          throw Error(`Unmapped source history: ${table.name}`);
        continue;
      }
      const rows = new Set(
        migrated.rows.map((r) =>
          JSON.stringify(table.columns.map((c) => r[c])),
        ),
      );
      if (
        table.rows.some(
          (row) => !rows.has(JSON.stringify(table.columns.map((c) => row[c]))),
        )
      )
        throw Error(`History changed during conversion: ${table.name}`);
    }
    await save("candidate-proof", {
      converted,
      digests: tableDigests(candidate),
    });
    const migration = readFileSync(
      new URL("../migrations/0001_wiki_migration_lineage.sql", import.meta.url),
      "utf8",
    );
    await d1.query(input.destination.databaseId, [
      ...migrationStatements(migration).map((sql) => ({ sql })),
      {
        sql: "INSERT INTO _outfitter_migrations (name,appliedAt) VALUES (?,?)",
        params: ["0001_wiki_migration_lineage", Date.now()],
      },
    ]);
    await stageCandidate(d1, input.destination.databaseId, candidate);
    await input.verifyAuthority();
    // Source locks are still present; exact source digest must remain unchanged.
    const recheck = await snapshotD1(d1, input.source.databaseId);
    verifyTables(source, recheck);
    promotionAttempted = true;
    try {
      await d1.query(
        input.destination.databaseId,
        promotionStatements(candidate),
      );
    } catch (error) {
      // Never blindly retry a write whose response may have been lost.
      const observed = await snapshotD1(d1, input.destination.databaseId);
      try {
        verifyTables(candidate, observed);
      } catch {
        throw error;
      }
    }
    const actual = await snapshotD1(d1, input.destination.databaseId);
    const verified = verifyTables(candidate, actual);
    const [foreignKeys] = await d1.query(input.destination.databaseId, [
      { sql: "PRAGMA foreign_key_check" },
    ]);
    if (foreignKeys.length)
      throw Error("Production foreign key verification failed");
    await input.verifyAppRead();
    // Authority history remains immutable even on the previously deployed app package.
    await d1.query(input.destination.databaseId, [
      ...sealLineage(),
      ...finishUnlockStatements(candidate, destination),
    ]);
    destinationLocked = false;
    finalized = true;
    const receipt = {
      id,
      owner: input.owner,
      source: input.source,
      destination: input.destination,
      sourceDigest: reconciliation.sourceDigest,
      verifiedAt: new Date().toISOString(),
      verified,
      sourceReadOnly: true,
      historyPreserved: true,
    };
    await save("receipt", receipt);
    return receipt;
  } catch (error) {
    await save("failure", {
      message: String(error),
      sourceLocked,
      destinationLocked,
      promotionAttempted,
      finalized,
    });
    if (!promotionAttempted) {
      if (destinationLocked)
        await d1.query(
          input.destination.databaseId,
          unlockStatements(destinationTables),
        );
      if (sourceLocked)
        await d1.query(input.source.databaseId, unlockStatements(sourceTables));
    }
    // A failed/lost promotion with uncertain state stays locked for explicit recovery.
    throw error;
  }
}
