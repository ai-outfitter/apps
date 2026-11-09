// One-off: copy an old Wiki Map database into a fresh Onto database, keeping ids and
// slugs, and list everything the new rules refuse. Delete this script once every
// organization's Onto is checked.
//
//   wrangler d1 export <old wiki database> --remote --output old.sql
//   sqlite3 old.sqlite < old.sql
//   node --import tsx scripts/import-old-wiki.ts old.sqlite onto.sqlite
//   sqlite3 onto.sqlite .dump > onto.sql   # then load onto.sql into the new Onto's D1
import { existsSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { appRecordKey, userKey } from "@ai-outfitter/app-sdk/graph-contracts";
import { standardData } from "../src/lib/standard-data";
import { storeType } from "../src/lib/type-metadata";

type Row = Record<string, SQLInputValue>;
const outfitterUser = "71000000-0000-4000-8000-000000000120";
const accountOf = "71000000-0000-4000-8000-000000000122";
const any = { from: "any", to: "any" } as const;

export function importOldWiki(oldPath: string, newPath: string) {
  const old = new DatabaseSync(oldPath, { readOnly: true });
  if (existsSync(newPath)) rmSync(newPath);
  const db = new DatabaseSync(newPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(new URL("../migrations/0000_onto.sql", import.meta.url), "utf8"));
  const report = { types: 0, nodes: 0, edges: 0, accounts: 0, openedEdgeTypes: [] as string[], refused: [] as string[], tables: {} as Record<string, number> };
  const has = (table: string) => !!old.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  const columns = (database: DatabaseSync, table: string) => (database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  const rows = (table: string) => (has(table) ? (old.prepare(`SELECT * FROM ${table}`).all() as Row[]) : []);
  const insert = (table: string, row: Row) => {
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map((k) => row[k]));
  };
  const parse = (value: SQLInputValue) => { try { return typeof value === "string" ? JSON.parse(value) : null; } catch { return null; } };

  // Types: the seed's definition wins for seed ids, so every seed edge type has its endpoints.
  // An edge type of the Wiki's own without endpoints opens to "any" and is listed.
  const seeds = new Map(standardData.types.map((type) => [type.id, type]));
  const now = Date.now();
  const typeNames = new Map<string, string>();
  const oldTypes = rows("graph_types");
  for (const type of [...oldTypes, ...standardData.types.filter((seed) => !oldTypes.some((t) => t.id === seed.id))] as Row[]) {
    const seed = seeds.get(String(type.id));
    let properties: unknown = seed ? storeType(seed).properties : parse(type.properties) ?? [];
    if (!seed && type.category === "edge") {
      const stored = Array.isArray(properties) ? { fields: properties } : (properties as { fields?: unknown; ontology?: Record<string, unknown> });
      const ontology = stored.ontology ?? { version: 2 };
      if (!ontology.endpoints && !ontology.projection) {
        properties = { ...stored, fields: stored.fields ?? [], ontology: { ...ontology, endpoints: any } };
        report.openedEdgeTypes.push(String(type.name));
      }
    }
    insert("graph_types", {
      id: type.id, category: seed?.category ?? type.category, name: seed?.name ?? type.name, title: seed?.title ?? type.title, body: seed?.body ?? type.body,
      properties: JSON.stringify(properties), archived: seed ? Number(seed.archived ?? false) : Number(type.archived ?? 0), seedVersion: type.seedVersion ?? null,
      revision: type.revision ?? 1, createdBy: type.createdBy ?? null, updatedBy: type.updatedBy ?? null, createdAt: type.createdAt ?? now, updatedAt: type.updatedAt ?? now,
    });
    typeNames.set(String(type.id), String(seed?.name ?? type.name));
    report.types++;
  }

  // Nodes: an app record's source becomes its key; a linked principal becomes an account.
  const slugs = new Map<string, string>();
  const accounts: Row[] = [];
  for (const node of rows("graph_nodes")) {
    const source = parse(node.source) as { installationId: string; type: string; id: string } | null;
    insert("graph_nodes", {
      id: node.id, typeId: node.typeId, slug: node.slug, title: node.title, summary: node.summary ?? "", body: node.body ?? "", website: node.website ?? null,
      properties: node.properties ?? "{}", externalKey: source ? appRecordKey(source) : null, archived: node.archived ?? 0, revision: node.revision ?? 1,
      createdBy: node.createdBy ?? null, updatedBy: node.updatedBy ?? null, createdAt: node.createdAt ?? now, updatedAt: node.updatedAt ?? now, validity: node.validity ?? null,
    });
    slugs.set(String(node.id), `${typeNames.get(String(node.typeId))}:${node.slug}`);
    if (node.externalProvider === "outfitter-principal" && node.externalId && !node.archived) accounts.push(node);
    report.nodes++;
  }
  for (const holder of accounts) {
    const id = crypto.randomUUID();
    insert("graph_nodes", { id, typeId: outfitterUser, slug: String(holder.slug), title: holder.title, externalKey: userKey(String(holder.externalId)), createdAt: now, updatedAt: now });
    insert("graph_edges", { id: crypto.randomUUID(), typeId: accountOf, fromId: id, toId: holder.id, createdAt: now, updatedAt: now });
    report.accounts++;
  }

  // Edges: validity moves to columns; whatever the endpoint trigger or identity index refuses is listed.
  for (const edge of rows("graph_edges")) {
    const validity = parse(edge.validity) as { from?: string | null; to?: string | null } | null;
    try {
      insert("graph_edges", {
        id: edge.id, typeId: edge.typeId, fromId: edge.fromId, toId: edge.toId, title: edge.title ?? "", body: edge.body ?? "", properties: edge.properties ?? "{}",
        archived: edge.archived ?? 0, revision: edge.revision ?? 1, createdBy: edge.createdBy ?? null, updatedBy: edge.updatedBy ?? null,
        createdAt: edge.createdAt ?? now, updatedAt: edge.updatedAt ?? now, validFrom: validity?.from ?? null, validTo: validity?.to ?? null,
      });
      report.edges++;
    } catch (error) {
      report.refused.push(`${typeNames.get(String(edge.typeId)) ?? edge.typeId}(${slugs.get(String(edge.fromId)) ?? edge.fromId} → ${slugs.get(String(edge.toId)) ?? edge.toId}): ${(error as Error).message}`);
    }
  }

  // Everything else keeps the columns both schemas share.
  for (const table of ["graph_assets", "graph_batches", "graph_batch_operations", "graph_revisions", "graph_changes", "graph_change_receipts", "graph_assertion_confirmations", "wiki_map_proposals"]) {
    const shared = columns(db, table).filter((c) => columns(old, table).includes(c));
    let copied = 0;
    for (const row of rows(table)) {
      try { insert(table, Object.fromEntries(shared.map((c) => [c, row[c]]))); copied++; }
      catch (error) { report.refused.push(`${table} ${row.id ?? ""}: ${(error as Error).message}`); }
    }
    report.tables[table] = copied;
  }
  old.close();
  db.close();
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [oldPath, newPath] = process.argv.slice(2);
  if (!oldPath || !newPath) throw new Error("usage: import-old-wiki.ts <old.sqlite> <onto.sqlite>");
  const report = importOldWiki(oldPath, newPath);
  console.log(`Copied ${report.types} types, ${report.nodes} nodes, ${report.edges} edges and ${report.accounts} accounts.`);
  console.log(`Other tables: ${Object.entries(report.tables).map(([t, n]) => `${t} ${n}`).join(", ")}`);
  if (report.openedEdgeTypes.length) console.log(`Edge types with no endpoints, opened to "any": ${report.openedEdgeTypes.join(", ")}`);
  if (report.refused.length) console.log(`Refused (${report.refused.length}):\n${report.refused.map((line) => `  ${line}`).join("\n")}`);
}
