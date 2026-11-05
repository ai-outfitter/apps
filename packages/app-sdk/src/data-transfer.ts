import { z } from "zod";
import type { AgentDatabase, AgentStatement } from "./agent-store";
import { migrationLedger } from "./migrations";
import {
  readJSON,
  requestIdentity,
  requireEditor,
  respond,
  sha256Hex,
  type AppIdentity,
} from "./server";

// Standard export and import of one installation's own database
// (docs/plans/app-data-export.md). The SDK reads the app's tables directly,
// so an app takes part without writing an exporter. Export keeps every app
// table, so a backup loses nothing; `exclude` applies to import. Import matches rows by
// primary key: missing rows are added, rows with a newer `revision` (or
// `updatedAt`) replace older ones, and rows only in the destination are kept.

export const archiveFormat = "outfitter-app-archive-v1";

/** Tables the SDK never transfers: SQLite/D1 internals and the migration ledger. */
const internal = /^(sqlite_|_cf_|d1_|_outfitter_migrations$)/;
/** Not imported: file bytes do not travel yet, so their index would point at nothing. */
const defaultExclude = ["app_storage_objects"];
const pageRows = 500;
/** D1 caps a bound string near 2 MB; stay under it per statement, in UTF-8 bytes. */
const statementBytes = 1_500_000;
/** Pages stay well under the 16 MB the import route reads. */
const pageBytes = 4_000_000;
const uuid = /(?<![0-9a-f-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f-])/gi;
const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

const cell = z.union([z.string(), z.number(), z.null()]);
type Cells = z.infer<typeof cell>[];
const tablePage = z.strictObject({
  key: z.array(z.string()).min(1),
  columns: z.array(z.string()).min(1),
  rows: z.array(z.array(cell)),
});
export const appArchive = z.strictObject({
  format: z.literal(archiveFormat),
  app: z.strictObject({ id: z.string().max(128) }),
  source: z.strictObject({
    installationId: z.string().max(128),
    owner: z.strictObject({ kind: z.enum(["user", "organization"]), id: z.string().max(128) }),
    exportedBy: z.string().max(256),
    exportedAt: z.number().int(),
  }),
  migrations: z.array(z.string().max(128)),
  tables: z.record(z.string(), tablePage),
  cursor: z.string().nullable(),
});
export type AppArchive = z.infer<typeof appArchive>;

/** Source ID → destination ID: installations, organizations and the owner. */
export const idMap = z.record(z.string().regex(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i), z.string().min(1).max(128)).default({});
export type IdMap = z.infer<typeof idMap>;

export type TransferOptions = {
  /** App tables import leaves alone (rows that only mean something in the source installation). Export still keeps them. */
  exclude?: string[];
  /** App rules over the planned result; throw a Response to refuse it. */
  validate?: (db: AgentDatabase, plan: ImportPlan) => Promise<void>;
};

type Table = {
  name: string;
  columns: string[];
  /** Declared column types, upper case (STRICT tables: INTEGER, REAL, TEXT, ANY). */
  types: Record<string, string>;
  key: string[];
  /** An INTEGER `revision` or `updatedAt` column; rows without one are receipts. */
  version?: "revision" | "updatedAt";
  /** Unique indexes other than the primary key, as column lists. */
  unique: string[][];
  parents: string[];
};

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

const excluded = (extra: string[] = []) => new Set([...defaultExclude, ...extra]);

async function tables(db: AgentDatabase, skip = new Set<string>()): Promise<Table[]> {
  const names = (await db.query({ sql: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name" }))
    .map((row) => String(row.name))
    .filter((name) => !internal.test(name) && !skip.has(name));
  const result: Table[] = [];
  for (const name of names) {
    const info = await db.query({ sql: `SELECT name, type, pk FROM pragma_table_info(?) ORDER BY cid`, params: [name] });
    const key = info.filter((c) => Number(c.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map((c) => String(c.name));
    if (!key.length) continue; // write guards and other keyless scratch tables
    const columns = info.map((c) => String(c.name));
    const parents = (await db.query({ sql: `SELECT "table" AS parent FROM pragma_foreign_key_list(?)`, params: [name] }))
      .map((row) => String(row.parent)).filter((parent) => parent !== name);
    const types = Object.fromEntries(info.map((c) => [String(c.name), String(c.type).toUpperCase()]));
    const version = (["revision", "updatedAt"] as const).find((c) => types[c] === "INTEGER");
    const indexes = await db.query({ sql: `SELECT name FROM pragma_index_list(?) WHERE "unique" = 1 AND origin != 'pk' AND partial = 0`, params: [name] });
    const unique = [];
    for (const index of indexes)
      unique.push((await db.query({ sql: "SELECT name FROM pragma_index_info(?) ORDER BY seqno", params: [String(index.name)] })).map((c) => String(c.name)));
    result.push({ name, columns, types, key, ...(version ? { version } : {}), unique, parents });
  }
  // Parents before children, so a destination that checks foreign keys per statement still accepts the rows.
  const ordered: Table[] = [];
  const placed = new Set<string>();
  const byName = new Map(result.map((t) => [t.name, t]));
  const visit = (table: Table, path: Set<string>) => {
    if (placed.has(table.name) || path.has(table.name)) return;
    path.add(table.name);
    for (const parent of table.parents) {
      const found = byName.get(parent);
      if (found) visit(found, path);
    }
    placed.add(table.name);
    ordered.push(table);
  };
  for (const table of result) visit(table, new Set());
  return ordered;
}

async function ledger(db: AgentDatabase) {
  const exists = await db.query({ sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", params: [migrationLedger] });
  if (!exists.length) return [];
  return (await db.query({ sql: `SELECT name FROM ${migrationLedger} ORDER BY name` })).map((row) => String(row.name));
}

function exportedCell(value: unknown, table: string): z.infer<typeof cell> {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new Response(`Table ${table} holds binary data, which archives do not carry yet`, { status: 422 });
}

/** Keyset cursor: the table being read and the last key sent, so rows written mid-export are neither skipped nor repeated. */
const cursorSchema = z.strictObject({ table: z.string(), after: z.array(cell).nullable() });
type Cursor = z.infer<typeof cursorSchema>;
const encodeCursor = (value: Cursor) => btoa(encodeURIComponent(JSON.stringify(value)));
function decodeCursor(value: string | null | undefined): Cursor | undefined {
  if (!value) return undefined;
  try { return cursorSchema.parse(JSON.parse(decodeURIComponent(atob(value)))); }
  catch { throw new Response("Invalid cursor", { status: 400 }); }
}

/** One page of the installation's archive; follow `cursor` until it is null. */
/** Rows of one table after `after`, until the table ends or `room` bytes are used. */
async function readRows(db: AgentDatabase, table: Table, after: Cells | null, room: number, first: boolean) {
  const keys = table.key.map(quote).join(",");
  const rows = await db.query({
    sql: `SELECT ${table.columns.map(quote).join(",")} FROM ${quote(table.name)}${after ? ` WHERE (${keys}) > (${table.key.map(() => "?").join(",")})` : ""} ORDER BY ${keys} LIMIT ?`,
    params: [...(after ?? []), pageRows],
  });
  const out: Cells[] = [];
  let bytes = 0;
  for (const row of rows) {
    const values = table.columns.map((column) => exportedCell(row[column], table.name));
    const size = byteLength(values);
    // Always send at least one row per page, so paging makes progress.
    if (bytes + size > room && !(first && !out.length)) return { rows: out, bytes, after, full: true };
    out.push(values);
    bytes += size;
    after = table.key.map((column) => values[table.columns.indexOf(column)]);
  }
  return { rows: out, bytes, after, full: false, ended: rows.length < pageRows };
}

/** One page of the installation's archive; follow `cursor` until it is null. */
export async function exportArchive(
  db: AgentDatabase,
  who: Pick<AppIdentity, "installationId" | "owner" | "userId">,
  options: { app: string; cursor?: string | null; maxBytes?: number },
): Promise<AppArchive> {
  const maxBytes = options.maxBytes ?? pageBytes;
  const all = await tables(db);
  const cursor = decodeCursor(options.cursor);
  let index = cursor ? all.findIndex((t) => t.name === cursor.table) : 0;
  if (index < 0) throw new Response("Invalid cursor", { status: 400 });
  let after = cursor?.after ?? null;
  const page: AppArchive["tables"] = {};
  let bytes = 0;
  let next: Cursor | null = null;
  while (index < all.length && !next) {
    const table = all[index];
    const read = await readRows(db, table, after, maxBytes - bytes, bytes === 0);
    page[table.name] ??= { key: table.key, columns: table.columns, rows: [] };
    page[table.name].rows.push(...read.rows);
    bytes += read.bytes;
    after = read.after;
    if (read.full) next = { table: table.name, after };
    else if (read.ended) { index++; after = null; }
  }
  return {
    format: archiveFormat,
    app: { id: options.app },
    source: { installationId: who.installationId, owner: who.owner, exportedBy: who.userId, exportedAt: Date.now() },
    migrations: await ledger(db),
    tables: page,
    cursor: next ? encodeCursor(next) : null,
  };
}

/** Replaces whole mapped UUIDs anywhere in a text cell, including inside JSON. */
function remap(value: z.infer<typeof cell>, map: Map<string, string>) {
  if (typeof value !== "string" || !map.size) return value;
  return value.replace(uuid, (id) => map.get(id.toLowerCase()) ?? id);
}

type Outcome = "added" | "updated" | "unchanged" | "newerLocally" | "conflict";
export type TablePlan = {
  table: string;
  columns: string[];
  key: string[];
  version?: Table["version"];
  counts: Record<Outcome, number>;
  /** Up to 20 conflicting primary keys, for the person to reconcile. */
  conflicts: string[][];
  /** Incoming rows to write (added and updated), after ID mapping. */
  writes: z.infer<typeof cell>[][];
};
export type ImportPlan = { tables: TablePlan[]; previewToken: string };

const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);

function decide(table: Table, columns: string[], incoming: z.infer<typeof cell>[], existing?: Record<string, unknown>): Outcome {
  if (!existing) return "added";
  if (columns.every((column, i) => same(existing[column], incoming[i]))) return "unchanged";
  if (!table.version) return "conflict";
  const at = columns.indexOf(table.version);
  const mine = existing[table.version], theirs = at < 0 ? null : incoming[at];
  // Matches the upsert guard: a local row without a version is older than any versioned one.
  if (theirs === null) return mine === null ? "conflict" : "newerLocally";
  if (mine === null || mine === undefined) return "updated";
  const delta = Number(theirs) - Number(mine);
  return delta > 0 ? "updated" : delta < 0 ? "newerLocally" : "conflict";
}

type Page = AppArchive["tables"][string];

/** Whether a cell fits a STRICT column type, so a bad archive is refused before the batch. */
function fits(type: string | undefined, value: z.infer<typeof cell>) {
  if (value === null || type === "ANY" || !type) return true;
  if (type === "INTEGER" || type === "INT") return Number.isInteger(value);
  if (type === "REAL") return typeof value === "number";
  if (type === "TEXT") return typeof value === "string";
  return true;
}

function checkPage(name: string, page: Page, table: Table) {
  const unknown = page.columns.filter((column) => !table.columns.includes(column));
  if (unknown.length) throw new Response(`Upgrade this app first; ${name} lacks ${unknown.join(", ")}`, { status: 409 });
  if (JSON.stringify(page.key) !== JSON.stringify(table.key))
    throw new Response(`Table ${name} changed its primary key; archives cannot cross that change`, { status: 409 });
  if (new Set(page.columns).size !== page.columns.length || table.key.some((column) => !page.columns.includes(column)))
    throw new Response(`Malformed columns in ${name}`, { status: 400 });
  for (const row of page.rows)
    if (row.length !== page.columns.length || row.some((value, i) => !fits(table.types[page.columns[i]], value)))
      throw new Response(`Malformed row in ${name}`, { status: 400 });
}

/** Unique-index values of the rows this import writes, mapped to their primary keys. */
function uniqueOwners(table: Table, plan: TablePlan, columns: string[]) {
  const at = columns.map((column) => plan.columns.indexOf(column));
  const keyAt = table.key.map((column) => plan.columns.indexOf(column));
  const owners = new Map<string, string>();
  if (at.some((i) => i < 0)) return owners;
  for (const row of plan.writes) {
    const values = at.map((i) => row[i]);
    if (values.some((value) => value === null)) continue; // NULLs never collide
    const value = JSON.stringify(values), key = JSON.stringify(keyAt.map((i) => row[i]));
    if (owners.has(value) && owners.get(value) !== key) throw new Response(`The archive repeats ${columns.join(", ")} in ${table.name}`, { status: 409 });
    owners.set(value, key);
  }
  return owners;
}

/** Refuses writes that would collide with another row on a unique index, so the batch never fails on one. */
async function checkUnique(db: AgentDatabase, table: Table, plan: TablePlan) {
  for (const columns of table.unique) {
    const owners = uniqueOwners(table, plan, columns);
    const tuples = [...owners.keys()].map((value) => JSON.parse(value) as Cells);
    const per = Math.floor(90 / columns.length);
    for (let start = 0; start < tuples.length; start += per) {
      const chunk = tuples.slice(start, start + per);
      const found = await db.query({
        sql: `SELECT ${[...table.key, ...columns].map(quote).join(",")} FROM ${quote(table.name)} WHERE (${columns.map(quote).join(",")}) IN (VALUES ${chunk.map(() => `(${columns.map(() => "?").join(",")})`).join(",")})`,
        params: chunk.flat(),
      });
      for (const row of found)
        if (owners.get(JSON.stringify(columns.map((c) => row[c]))) !== JSON.stringify(table.key.map((c) => row[c])))
          throw new Response(`${columns.join(", ")} in ${table.name} already belongs to another record here; reconcile it before importing`, { status: 409 });
    }
  }
}

/** Destination rows with the incoming keys, keyed by their JSON-encoded key. */
async function existingRows(db: AgentDatabase, table: Table, keys: string[][]) {
  const found = new Map<string, Record<string, unknown>>();
  const tuple = `(${table.key.map(() => "?").join(",")})`;
  // D1 binds at most 100 parameters per query.
  const per = Math.floor(90 / table.key.length);
  for (let start = 0; start < keys.length; start += per) {
    const chunk = keys.slice(start, start + per);
    const rows = await db.query({
      sql: `SELECT * FROM ${quote(table.name)} WHERE (${table.key.map(quote).join(",")}) IN (VALUES ${chunk.map(() => tuple).join(",")})`,
      params: chunk.flat(),
    });
    for (const row of rows) found.set(JSON.stringify(table.key.map((c) => String(row[c]))), row);
  }
  return found;
}

async function planTable(db: AgentDatabase, table: Table, page: Page, map: Map<string, string>) {
  checkPage(table.name, page, table);
  const keyAt = table.key.map((column) => page.columns.indexOf(column));
  const keyOf = (row: Cells) => keyAt.map((i) => String(row[i]));
  const rows = page.rows.map((row) => row.map((value) => remap(value, map)));
  const existing = await existingRows(db, table, rows.map(keyOf));
  const plan: TablePlan = {
    table: table.name, columns: page.columns, key: table.key, version: table.version && page.columns.includes(table.version) ? table.version : undefined,
    counts: { added: 0, updated: 0, unchanged: 0, newerLocally: 0, conflict: 0 },
    conflicts: [], writes: [],
  };
  for (const row of rows) {
    const outcome = decide(table, page.columns, row, existing.get(JSON.stringify(keyOf(row))));
    plan.counts[outcome]++;
    if (outcome === "conflict" && plan.conflicts.length < 20) plan.conflicts.push(keyOf(row));
    if (outcome === "added" || outcome === "updated") plan.writes.push(row);
  }
  await checkUnique(db, table, plan);
  return { plan, existing: [...existing.values()] };
}

/** Reads, without writing, what importing `archive` would change. */
export async function planImport(
  db: AgentDatabase,
  who: Pick<AppIdentity, "installationId">,
  input: { archive: AppArchive; map?: IdMap },
  options: TransferOptions = {},
): Promise<ImportPlan> {
  const archive = appArchive.parse(input.archive);
  const map = new Map(Object.entries(input.map ?? {}).map(([from, to]) => [from.toLowerCase(), to]));
  const applied = new Set(await ledger(db));
  const missing = archive.migrations.filter((name) => !applied.has(name));
  if (missing.length)
    throw new Response(`Upgrade this app first; the destination lacks migrations ${missing.join(", ")}`, { status: 409 });
  const skipped = excluded(options.exclude);
  const destination = new Map((await tables(db, skipped)).map((t) => [t.name, t]));
  const plans: TablePlan[] = [];
  // The destination rows each plan read: if any change before import, the token does too.
  const seen: unknown[] = [];
  for (const [name, page] of Object.entries(archive.tables)) {
    const table = destination.get(name);
    if (!table && skipped.has(name)) continue;
    if (!table) throw new Response(`Upgrade this app first; the destination has no table ${name}`, { status: 409 });
    const { plan, existing } = await planTable(db, table, page, map);
    plans.push(plan);
    seen.push(existing);
  }
  const previewToken = await sha256Hex(JSON.stringify([who.installationId, archive, input.map ?? {}, seen]));
  const result = { tables: plans, previewToken };
  await options.validate?.(db, result);
  return result;
}

const summary = (plan: ImportPlan) => plan.tables.map(({ writes: _writes, ...rest }) => rest);

function chunks<T>(rows: T[]) {
  const out: T[][] = [];
  let current: T[] = [], size = 0;
  for (const row of rows) {
    const length = byteLength(row);
    if (length > statementBytes) throw new Response("A row is larger than one import statement can carry", { status: 413 });
    if (current.length && size + length > statementBytes) { out.push(current); current = []; size = 0; }
    current.push(row); size += length;
  }
  if (current.length) out.push(current);
  return out;
}

/** Applies a previewed import as one atomic batch; a changed destination needs a new preview. */
export async function applyImport(
  db: AgentDatabase,
  who: Pick<AppIdentity, "installationId">,
  input: { archive: AppArchive; map?: IdMap; previewToken: string },
  options: TransferOptions = {},
) {
  const plan = await planImport(db, who, input, options);
  if (plan.previewToken !== input.previewToken)
    throw new Response("Import preview changed; preview this destination and archive again", { status: 409 });
  const statements: AgentStatement[] = [{ sql: "PRAGMA defer_foreign_keys = on" }];
  for (const table of plan.tables) {
    if (!table.writes.length) continue;
    const columns = table.columns.map(quote).join(",");
    const values = table.columns.map((_, i) => `json_extract(value, '$[${i}]')`).join(",");
    const updates = table.columns.filter((c) => !table.key.includes(c)).map((c) => `${quote(c)} = excluded.${quote(c)}`);
    const { version } = table;
    // The upsert's own guard keeps a row edited since the preview from being replaced by an older one.
    const conflict = version && updates.length
      ? `ON CONFLICT (${table.key.map(quote).join(",")}) DO UPDATE SET ${updates.join(",")} WHERE ${quote(table.table)}.${quote(version)} IS NULL OR ${quote(table.table)}.${quote(version)} < excluded.${quote(version)}`
      : "ON CONFLICT DO NOTHING";
    for (const rows of chunks(table.writes))
      statements.push({
        sql: `INSERT INTO ${quote(table.table)} (${columns}) SELECT ${values} FROM json_each(?) WHERE true ${conflict}`,
        params: [JSON.stringify(rows)],
      });
  }
  if (statements.length > 1) await db.batch(statements);
  return { tables: summary(plan) };
}

const importBody = z.strictObject({ archive: appArchive, map: idMap, previewToken: z.string().regex(/^[a-f0-9]{64}$/).optional() });

async function readImport(request: Request, app: string) {
  const input = await readJSON(request, importBody, 16_000_000);
  if (input.archive.app.id !== app) throw new Response(`This archive belongs to ${input.archive.app.id}`, { status: 409 });
  return input;
}

/** The installation's transfer API: GET `export?cursor=`, POST `preview` and `import`. */
export function dataTransferRoutes(database: () => AgentDatabase, options: TransferOptions & { app: string }) {
  return ({ request, params }: { request: Request; params: Record<string, string | undefined> }) =>
    respond(async () => {
      const who = requestIdentity(request);
      // Archives carry every column, including fields ordinary reads hide, so only owners and admins export.
      requireEditor(who);
      const route = `${request.method} ${params.operation}`;
      if (route === "GET export")
        return exportArchive(database(), who, { ...options, cursor: new URL(request.url).searchParams.get("cursor") });
      if (route === "POST preview") {
        const plan = await planImport(database(), who, await readImport(request, options.app), options);
        return { previewToken: plan.previewToken, tables: summary(plan) };
      }
      if (route === "POST import") {
        const { previewToken, ...input } = await readImport(request, options.app);
        if (!previewToken) throw new Response("A preview token is required", { status: 400 });
        return applyImport(database(), who, { ...input, previewToken }, options);
      }
      return new Response("Not found", { status: 404 });
    });
}
