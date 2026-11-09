// Offline migration rehearsal against a trusted installation backup. This is not
// a portable import or a live cutover: authority and cross-installation references
// still require verified lineage. Refuse the candidate rather than lose data.
//
//   wrangler d1 export <old wiki database> --remote --output old.sql
//   sqlite3 old.sqlite < old.sql
//   node --import tsx scripts/import-old-wiki.ts old.sqlite onto.sqlite
//   sqlite3 onto.sqlite .dump > onto.sql   # then load onto.sql into the new Onto's D1
import { openSync, closeSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { appRecordKey, userKey } from "@ai-outfitter/app-sdk/graph-contracts";
import { standardData } from "../src/lib/standard-data";
import { storeType } from "../src/lib/type-metadata";

type Row = Record<string, SQLInputValue>;
const outfitterUser = "71000000-0000-4000-8000-000000000120";
const accountOf = "71000000-0000-4000-8000-000000000122";

export class WikiMigrationError extends Error {
  constructor(public report: { refused: string[] }) {
    super(
      `Wiki migration refused; no destination retained:\n${report.refused.join("\n")}`,
    );
  }
}

export function importOldWiki(oldPath: string, newPath: string) {
  // O_EXCL also refuses symlinks and an alias of the source. Never overwrite a database.
  closeSync(openSync(newPath, "wx", 0o600));
  let old: DatabaseSync | undefined;
  let db: DatabaseSync | undefined;
  let complete = false;
  try {
    old = new DatabaseSync(oldPath, { readOnly: true });
    db = new DatabaseSync(newPath);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(
      readFileSync(
        new URL("../migrations/0000_onto.sql", import.meta.url),
        "utf8",
      ),
    );
    const report = {
      types: 0,
      nodes: 0,
      edges: 0,
      accounts: 0,
      refused: [] as string[],
      tables: {} as Record<string, number>,
    };
    const source = old,
      destination = db;
    source.exec("BEGIN");
    destination.exec("BEGIN");
    const has = (table: string) =>
      !!source
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(table);
    const columns = (database: DatabaseSync, table: string) =>
      (
        database.prepare(`PRAGMA table_info(${table})`).all() as {
          name: string;
        }[]
      ).map((c) => c.name);
    const rows = (table: string) =>
      has(table)
        ? (source.prepare(`SELECT * FROM ${table}`).all() as Row[])
        : [];
    const insert = (table: string, row: Row) => {
      const keys = Object.keys(row);
      destination
        .prepare(
          `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
        )
        .run(...keys.map((k) => row[k]));
    };
    const parse = (value: SQLInputValue) =>
      typeof value === "string" ? JSON.parse(value) : null;

    // Preserve existing type definitions and revisions. New seed ids are add-only;
    // missing endpoint contracts require explicit reconciliation before cutover.
    const seeds = new Map(standardData.types.map((type) => [type.id, type]));
    const now = Date.now();
    const typeNames = new Map<string, string>();
    const oldTypes = rows("graph_types");
    for (const table of ["graph_types", "graph_nodes", "graph_edges"])
      if (!has(table))
        throw new Error(`Source is not a Wiki database: missing ${table}`);
    const historyTables = [
      "graph_assets",
      "graph_batches",
      "graph_batch_operations",
      "graph_revisions",
      "graph_changes",
      "graph_change_receipts",
      "graph_assertion_confirmations",
      "wiki_map_proposals",
      "onto_review_jobs",
      "graph_explorations",
      "wiki_map_agent_guard",
    ];
    const handled = new Set([
      "graph_types",
      "graph_nodes",
      "graph_edges",
      ...historyTables,
    ]);
    // A new source table cannot silently disappear during a future cutover.
    for (const { name } of source
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[]) {
      if (
        handled.has(name) ||
        name.startsWith("sqlite_") ||
        ["__drizzle_migrations", "d1_migrations", "_cf_KV"].includes(name)
      )
        continue;
      const quoted = '"' + name.replaceAll('"', '""') + '"';
      const count = source.prepare(`SELECT count(*) AS n FROM ${quoted}`).get()!
        .n;
      if (count)
        report.refused.push(
          `${name}: ${count} rows have no destination mapping`,
        );
    }
    for (const table of ["graph_types", "graph_nodes", "graph_edges"]) {
      const sourceColumns = columns(source, table);
      const transformed =
        table === "graph_nodes"
          ? ["source", "externalProvider", "externalId", "privateData"]
          : table === "graph_edges"
            ? ["validity"]
            : [];
      const mapped = new Set([...columns(destination, table), ...transformed]);
      for (const row of rows(table))
        for (const column of sourceColumns)
          if (!mapped.has(column) && row[column] !== null)
            report.refused.push(`${table}.${column}: no destination mapping`);
    }
    const additions = standardData.types.filter((seed) => {
      if (oldTypes.some((type) => type.id === seed.id)) return false;
      const existing = oldTypes.find((type) => type.name === seed.name);
      if (existing) {
        report.refused.push(
          `graph_types ${seed.name}: source id ${existing.id} conflicts with seed id ${seed.id}; explicit identity mapping required`,
        );
        return false;
      }
      return true;
    });
    for (const type of [...oldTypes, ...additions] as Row[]) {
      const seed = oldTypes.some((row) => row.id === type.id)
        ? undefined
        : seeds.get(String(type.id));
      let properties: unknown = seed
        ? storeType(seed).properties
        : (parse(type.properties) ?? []);
      if (type.category === "edge") {
        const stored = Array.isArray(properties)
          ? { fields: properties }
          : (properties as {
              fields?: unknown;
              ontology?: Record<string, unknown>;
            });
        const ontology = stored.ontology ?? { version: 2 };
        if (!ontology.endpoints && !ontology.projection) {
          report.refused.push(
            `graph_types ${type.name}: missing endpoint contract; reconcile explicitly before migration`,
          );
        }
      }
      insert("graph_types", {
        id: type.id,
        category: seed?.category ?? type.category,
        name: seed?.name ?? type.name,
        title: seed?.title ?? type.title,
        body: seed?.body ?? type.body,
        properties: JSON.stringify(properties),
        archived: seed
          ? Number(seed.archived ?? false)
          : Number(type.archived ?? 0),
        seedVersion: type.seedVersion ?? null,
        revision: type.revision ?? 1,
        createdBy: type.createdBy ?? null,
        updatedBy: type.updatedBy ?? null,
        createdAt: type.createdAt ?? now,
        updatedAt: type.updatedAt ?? now,
      });
      typeNames.set(String(type.id), String(seed?.name ?? type.name));
      report.types++;
    }

    // Nodes: an app record's source becomes its key; a linked principal becomes an account.
    const slugs = new Map<string, string>();
    const accounts: Row[] = [];
    for (const node of rows("graph_nodes")) {
      if (node.privateData && node.privateData !== "{}")
        report.refused.push(
          `graph_nodes ${node.id}: privateData needs a separate owner-scoped retention mapping`,
        );
      if (
        node.externalProvider &&
        node.externalProvider !== "outfitter-principal"
      )
        report.refused.push(
          `graph_nodes ${node.id}: unsupported external provider ${node.externalProvider}`,
        );
      const source = parse(node.source) as {
        installationId: string;
        type: string;
        id: string;
      } | null;
      insert("graph_nodes", {
        id: node.id,
        typeId: node.typeId,
        slug: node.slug,
        title: node.title,
        summary: node.summary ?? "",
        body: node.body ?? "",
        website: node.website ?? null,
        properties: node.properties ?? "{}",
        externalKey: source ? appRecordKey(source) : null,
        archived: node.archived ?? 0,
        revision: node.revision ?? 1,
        createdBy: node.createdBy ?? null,
        updatedBy: node.updatedBy ?? null,
        createdAt: node.createdAt ?? now,
        updatedAt: node.updatedAt ?? now,
        validity: node.validity ?? null,
      });
      slugs.set(
        String(node.id),
        `${typeNames.get(String(node.typeId))}:${node.slug}`,
      );
      if (
        node.externalProvider === "outfitter-principal" &&
        node.externalId &&
        !node.archived
      )
        accounts.push(node);
      report.nodes++;
    }
    for (const holder of accounts) {
      const id = crypto.randomUUID();
      insert("graph_nodes", {
        id,
        typeId: outfitterUser,
        slug: String(holder.slug),
        title: holder.title,
        externalKey: userKey(String(holder.externalId)),
        createdAt: now,
        updatedAt: now,
      });
      insert("graph_edges", {
        id: crypto.randomUUID(),
        typeId: accountOf,
        fromId: id,
        toId: holder.id,
        createdAt: now,
        updatedAt: now,
      });
      report.accounts++;
    }

    // Edges: validity moves to columns; whatever the endpoint trigger or identity index refuses is listed.
    for (const edge of rows("graph_edges")) {
      const validity = parse(edge.validity) as {
        from?: string | null;
        to?: string | null;
      } | null;
      try {
        insert("graph_edges", {
          id: edge.id,
          typeId: edge.typeId,
          fromId: edge.fromId,
          toId: edge.toId,
          title: edge.title ?? "",
          body: edge.body ?? "",
          properties: edge.properties ?? "{}",
          archived: edge.archived ?? 0,
          revision: edge.revision ?? 1,
          createdBy: edge.createdBy ?? null,
          updatedBy: edge.updatedBy ?? null,
          createdAt: edge.createdAt ?? now,
          updatedAt: edge.updatedAt ?? now,
          validFrom: validity?.from ?? null,
          validTo: validity?.to ?? null,
        });
        report.edges++;
      } catch (error) {
        report.refused.push(
          `${typeNames.get(String(edge.typeId)) ?? edge.typeId}(${slugs.get(String(edge.fromId)) ?? edge.fromId} → ${slugs.get(String(edge.toId)) ?? edge.toId}): ${(error as Error).message}`,
        );
      }
    }

    // Preserve all mapped history columns. Unknown populated columns block cutover.
    for (const table of historyTables) {
      const shared = columns(destination, table).filter((c) =>
        columns(source, table).includes(c),
      );
      let copied = 0;
      const unmapped = columns(source, table).filter(
        (c) => !shared.includes(c),
      );
      for (const row of rows(table)) {
        for (const column of unmapped)
          if (row[column] !== null)
            report.refused.push(`${table}.${column}: no destination mapping`);
        try {
          insert(table, Object.fromEntries(shared.map((c) => [c, row[c]])));
          copied++;
        } catch (error) {
          report.refused.push(
            `${table} ${row.id ?? ""}: ${(error as Error).message}`,
          );
        }
      }
      report.tables[table] = copied;
    }
    const broken = destination.prepare("PRAGMA foreign_key_check").all();
    if (broken.length)
      report.refused.push(
        `Foreign key check failed for ${broken.length} records`,
      );
    if (report.refused.length) throw new WikiMigrationError(report);
    destination.exec("COMMIT");
    chmodSync(newPath, 0o600);
    complete = true;
    return report;
  } finally {
    old?.close();
    db?.close();
    if (!complete) rmSync(newPath, { force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [oldPath, newPath] = process.argv.slice(2);
  if (!oldPath || !newPath)
    throw new Error("usage: import-old-wiki.ts <old.sqlite> <onto.sqlite>");
  const report = importOldWiki(oldPath, newPath);
  console.log(
    `Copied ${report.types} types, ${report.nodes} nodes, ${report.edges} edges and ${report.accounts} accounts.`,
  );
  console.log(
    `Other tables: ${Object.entries(report.tables)
      .map(([t, n]) => `${t} ${n}`)
      .join(", ")}`,
  );
}
