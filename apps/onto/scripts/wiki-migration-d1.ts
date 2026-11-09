/** Trusted operator transport. Credentials never enter app builds or portable imports. */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, closeSync, openSync, rmSync } from "node:fs";
import { quote, sourceTables, digest } from "./reconcile-wiki";
export type Statement = { sql: string; params?: unknown[] };
export function d1Operator(accountId: string, token: string, request = fetch) {
  if (!/^[a-f0-9]{32}$/.test(accountId) || !token)
    throw Error("Explicit Cloudflare account and token required");
  async function api(path: string, method = "GET", body?: unknown) {
    const r = await request(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(120000),
      },
    );
    const result = (await r.json()) as {
      success: boolean;
      result: any;
      errors: { code: number; message: string }[];
    };
    if (!r.ok || !result.success)
      throw Error(
        `D1 operation failed (${r.status}): ${result.errors?.map((e) => e.message).join("; ")}`,
      );
    return result.result;
  }
  async function query(
    database: string,
    statements: Statement[],
  ): Promise<Record<string, SQLInputValue>[][]> {
    if (!/^[a-f0-9-]{36}$/.test(database))
      throw Error("Invalid database identity");
    const results = await api(`/${database}/query`, "POST", {
      batch: statements,
    });
    if (results.some((r: any) => !r.success))
      throw Error("D1 batch did not succeed");
    return results.map(
      (r: any) => r.results as Record<string, SQLInputValue>[],
    );
  }
  return { api, query };
}
export type Snapshot = {
  tables: {
    name: string;
    columns: string[];
    rows: Record<string, SQLInputValue>[];
  }[];
};
export type D1 = ReturnType<typeof d1Operator>;
export async function snapshotD1(d1: D1, id: string): Promise<Snapshot> {
  const [schema] = await d1.query(id, [
    {
      sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('_cf_KV','_outfitter_migrations') ORDER BY name",
    },
  ]);
  const names = schema.map((r) => String(r.name));
  const data = await d1.query(
    id,
    names.flatMap((name) => [
      { sql: `PRAGMA table_info(${quote(name)})` },
      { sql: `SELECT * FROM ${quote(name)}` },
    ]),
  );
  return {
    tables: names.map((name, i) => ({
      name,
      columns: data[i * 2].map((c) => String(c.name)),
      rows: data[i * 2 + 1],
    })),
  };
}
export function materializeSnapshot(snapshot: Snapshot, path: string) {
  closeSync(openSync(path, "wx", 0o600));
  const db = new DatabaseSync(path);
  let complete = false;
  try {
    db.exec("BEGIN");
    for (const t of snapshot.tables) {
      db.exec(
        `CREATE TABLE ${quote(t.name)} (${t.columns.map(quote).join(",")})`,
      );
      const insert = db.prepare(
        `INSERT INTO ${quote(t.name)} VALUES (${t.columns.map(() => "?").join(",")})`,
      );
      for (const r of t.rows) insert.run(...t.columns.map((c) => r[c]));
    }
    db.exec("COMMIT");
    complete = true;
  } finally {
    db.close();
    if (!complete) rmSync(path, { force: true });
  }
}
const prefix = "_onto_cutover_";
export function lockStatements(tables: string[], message: string): Statement[] {
  return tables.flatMap((table) =>
    ["INSERT", "UPDATE", "DELETE"].map((op) => ({
      sql: `CREATE TRIGGER ${quote(prefix + table + "_" + op)} BEFORE ${op} ON ${quote(table)} BEGIN SELECT RAISE(ABORT, '${message.replaceAll("'", "''")}'); END`,
    })),
  );
}
export function unlockStatements(tables: string[]): Statement[] {
  return tables.flatMap((table) =>
    ["INSERT", "UPDATE", "DELETE"].map((op) => ({
      sql: `DROP TRIGGER IF EXISTS ${quote(prefix + table + "_" + op)}`,
    })),
  );
}
export function tableDigests(snapshot: Snapshot) {
  return Object.fromEntries(
    snapshot.tables.map((t) => [
      t.name,
      {
        rows: t.rows.length,
        sha256: digest(
          t.rows.map((r) => JSON.stringify(t.columns.map((c) => r[c]))).sort(),
        ),
      },
    ]),
  );
}
export function verifyTables(expected: Snapshot, actual: Snapshot) {
  const a = tableDigests(actual),
    e = tableDigests(expected);
  for (const [table, hash] of Object.entries(e))
    if (JSON.stringify(hash) !== JSON.stringify(a[table]))
      throw Error(`Migration readback mismatch: ${table}`);
  return e;
}
export function candidateSnapshot(path: string): Snapshot {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return { tables: sourceTables(db) };
  } finally {
    db.close();
  }
}
export function addDestinationSeeds(
  path: string,
  destination: Snapshot,
  aliases: Record<string, string>,
) {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys=ON; BEGIN");
    for (const table of ["graph_types", "graph_nodes", "graph_edges"]) {
      const source = destination.tables.find((t) => t.name === table);
      if (!source) throw Error("Destination has no graph schema");
      const cols = db
        .prepare(`PRAGMA table_info(${quote(table)})`)
        .all()
        .map((c) => String(c.name));
      for (const original of source.rows) {
        if (table === "graph_types" && aliases[String(original.id)]) continue;
        if (
          db
            .prepare(`SELECT 1 FROM ${quote(table)} WHERE id=?`)
            .get(original.id)
        )
          continue;
        const row = { ...original };
        if (row.typeId) row.typeId = aliases[String(row.typeId)] ?? row.typeId;
        const insert = db.prepare(
          `INSERT INTO ${quote(table)} (${cols.map(quote).join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
        );
        insert.run(...cols.map((c) => row[c] ?? null));
      }
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}
export function addLineage(
  path: string,
  metadata: {
    id: string;
    sourceInstallationId: string;
    destinationInstallationId: string;
    owner: { kind: string; id: string };
    sourceDigest: string;
    reconciliation: unknown;
    actor: string;
  },
  source: Snapshot,
) {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(
      readFileSync(
        new URL(
          "../migrations/0001_wiki_migration_lineage.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    db.exec("BEGIN");
    const verification = tableDigests({
      tables: candidateSnapshot(path).tables.filter(
        (t) => !t.name.startsWith("onto_wiki_migration"),
      ),
    });
    db.prepare(
      "INSERT INTO onto_wiki_migrations VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run(
      metadata.id,
      metadata.sourceInstallationId,
      metadata.destinationInstallationId,
      metadata.owner.kind,
      metadata.owner.id,
      metadata.sourceDigest,
      JSON.stringify(metadata.reconciliation),
      JSON.stringify(verification),
      metadata.actor,
      Date.now(),
    );
    const insert = db.prepare(
      "INSERT INTO onto_wiki_migration_sources VALUES (?,?,?,?)",
    );
    for (const table of source.tables)
      for (let i = 0; i < table.rows.length; i++)
        insert.run(metadata.id, table.name, i, JSON.stringify(table.rows[i]));
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}
export async function stageCandidate(d1: D1, id: string, candidate: Snapshot) {
  // Read-only app operations can continue; live rows do not change until promotion.
  for (const t of candidate.tables) {
    const stage = quote(prefix + "stage_" + t.name);
    await d1.query(id, [
      {
        sql: `CREATE TABLE ${stage} AS SELECT * FROM ${quote(t.name)} WHERE 0`,
      },
    ]);
    const cols = t.columns;
    for (let i = 0; i < t.rows.length; i += 50) {
      await d1.query(
        id,
        t.rows.slice(i, i + 50).map((row) => ({
          sql: `INSERT INTO ${stage} (${cols.map(quote).join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
          params: cols.map((c) => row[c]),
        })),
      );
    }
  }
}
export function promotionStatements(candidate: Snapshot): Statement[] {
  const first = [
    "graph_types",
    "graph_nodes",
    "graph_edges",
    "graph_batches",
    "onto_wiki_migrations",
  ];
  const ordered = [...candidate.tables].sort((a, b) => {
    const rank = (name: string) => {
      const index = first.indexOf(name);
      return index < 0 ? first.length : index;
    };
    return rank(a.name) - rank(b.name);
  });
  const tables = ordered.map((t) => t.name);
  const deletion = [...tables].sort((a, b) =>
    a === "graph_types" ? 1 : b === "graph_types" ? -1 : 0,
  );
  return [
    { sql: "PRAGMA defer_foreign_keys=ON" },
    ...unlockStatements(tables),
    ...deletion.map((name) => ({ sql: `DELETE FROM ${quote(name)}` })),
    ...ordered.map((t) => ({
      sql: `INSERT INTO ${quote(t.name)} (${t.columns.map(quote).join(",")}) SELECT ${t.columns.map(quote).join(",")} FROM ${quote(prefix + "stage_" + t.name)}`,
    })),
    ...lockStatements(tables, "Onto migration verification in progress"),
    ...tables.map((name) => ({
      sql: `DROP TABLE ${quote(prefix + "stage_" + name)}`,
    })),
  ];
}

/** Protect trusted lineage even while an older app package is still serving. */
export function sealLineage(): Statement[] {
  return ["onto_wiki_migrations", "onto_wiki_migration_sources"].flatMap(
    (table) =>
      ["INSERT", "UPDATE", "DELETE"].map((op) => ({
        sql: `CREATE TRIGGER ${quote("_onto_lineage_sealed_" + table + "_" + op)} BEFORE ${op} ON ${quote(table)} BEGIN SELECT RAISE(ABORT, 'Trusted migration lineage is immutable'); END`,
      })),
  );
}

/** Include empty destination-only infrastructure tables, such as asset indexes. */
export function finishUnlockStatements(
  candidate: Snapshot,
  destinationBefore: Snapshot,
) {
  return unlockStatements([
    ...new Set(
      [...candidate.tables, ...destinationBefore.tables].map((t) => t.name),
    ),
  ]);
}
