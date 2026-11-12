/** One-time compatibility repair for a pre-graph Wiki database.
 * Run only after the trusted Wiki -> Onto migration has sealed its receipt.
 * The old table and all its child foreign keys remain in this Wiki database.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { d1Operator, type D1 } from "../../onto/scripts/wiki-migration-d1";

type Binding = { id: string; databaseId: string };
type Receipt = {
  owner: { kind: "user" | "organization"; id: string };
  source: Binding;
  destination: Binding;
  historyPreserved: true;
  sourceReadOnly: true;
};
type Input = { source: Binding; destination: Binding; owner: Receipt["owner"]; receipt: Receipt; backup: string; apply?: boolean };
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const digest = (rows: Record<string, unknown>[]) => createHash("sha256").update(JSON.stringify(rows.map(row => JSON.stringify(row)).sort())).digest("hex");
const legacy = ["wiki_pages", "wiki_assets", "wiki_links", "wiki_contacts"];

export async function reconcileLegacyPages(d1: D1, input: Input) {
  if (JSON.stringify(input.receipt.owner) !== JSON.stringify(input.owner)
    || JSON.stringify(input.receipt.source) !== JSON.stringify(input.source)
    || JSON.stringify(input.receipt.destination) !== JSON.stringify(input.destination)
    || input.receipt.historyPreserved !== true || input.receipt.sourceReadOnly !== true)
    throw Error("Verified migration receipt does not bind this owner and pair");
  if (!input.backup.endsWith(".local.json")) throw Error("Backup must be a private .local.json file");
  const [lineage] = await d1.query(input.destination.databaseId, [{
    sql: "SELECT ownerKind,ownerId,sourceInstallationId,destinationInstallationId FROM onto_wiki_migrations WHERE sourceInstallationId=? AND destinationInstallationId=?",
    params: [input.source.id, input.destination.id],
  }]);
  if (lineage.length !== 1 || lineage[0].ownerKind !== input.owner.kind || lineage[0].ownerId !== input.owner.id)
    throw Error("Current Onto has no matching trusted migration lineage");
  const [schema, ledger, foreignKeys, unmapped, counts, locks, divergent] = await d1.query(input.source.databaseId, [
    { sql: "SELECT name,sql FROM sqlite_master WHERE type='table' AND name IN ('wiki_pages','wiki_legacy_pages','wiki_documents','wiki_assets','wiki_links','wiki_contacts') ORDER BY name" },
    { sql: "SELECT name FROM _outfitter_migrations WHERE name='0012_documents'" },
    { sql: "PRAGMA foreign_key_check" },
    { sql: "SELECT count(*) AS count FROM wiki_pages p LEFT JOIN graph_nodes n ON n.id=p.id WHERE n.id IS NULL" },
    { sql: "SELECT (SELECT count(*) FROM wiki_pages) AS pages,(SELECT count(*) FROM wiki_assets) AS assets,(SELECT count(*) FROM wiki_links) AS links,(SELECT count(*) FROM wiki_contacts) AS contacts" },
    { sql: "SELECT name,tbl_name FROM sqlite_master WHERE type='trigger' AND name LIKE '_onto_cutover_%'" },
    { sql: "SELECT count(*) AS count FROM wiki_pages p JOIN graph_nodes n ON n.id=p.id WHERE p.slug!=n.slug OR p.title!=n.title OR p.summary!=n.summary OR p.body!=n.body OR p.revision!=n.revision" },
  ]);
  const names = new Set(schema.map(row => String(row.name)));
  if (!names.has("wiki_pages") || names.has("wiki_legacy_pages") || names.has("wiki_documents") || ledger.length)
    throw Error("Wiki document migration has started or legacy table is absent");
  if (foreignKeys.length || Number(unmapped[0]?.count) || Number(divergent[0]?.count))
    throw Error("Legacy Wiki has broken references or pages diverging from the migrated graph");
  for (const table of ["wiki_pages", "graph_types", "graph_nodes", "graph_edges"])
    for (const operation of ["INSERT", "UPDATE", "DELETE"])
      if (!locks.some(row => row.name === `_onto_cutover_${table}_${operation}` && row.tbl_name === table))
        throw Error(`Source graph cutover lock is absent: ${table} ${operation}`);
  const pagesDDL = String(schema.find(row => row.name === "wiki_pages")?.sql ?? "");
  if (!/\bkind\b/i.test(pagesDDL) || !/\bbody\b/i.test(pagesDDL) || /\bdocumentId\b/i.test(pagesDDL))
    throw Error("wiki_pages is not the supported legacy schema");
  for (const table of schema.filter(row => legacy.includes(String(row.name)) && row.name !== "wiki_pages"))
    if (!String(table.sql).includes("REFERENCES `wiki_pages`(`id`)"))
      throw Error(`Unexpected child foreign key schema: ${table.name}`);
  const before = await d1.query(input.source.databaseId, legacy.map(name => ({ sql: `SELECT * FROM ${quote(name)}` })));
  const archive = { owner: input.owner, source: input.source, destination: input.destination,
    schema, counts: counts[0], tables: Object.fromEntries(legacy.map((name, index) => [name, before[index]])),
    digests: Object.fromEntries(legacy.map((name, index) => [name, digest(before[index])])) };
  writeFileSync(input.backup, JSON.stringify(archive, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  if (!input.apply) return { applied: false, counts: counts[0], digests: archive.digests };
  await d1.query(input.source.databaseId, [{ sql: "ALTER TABLE wiki_pages RENAME TO wiki_legacy_pages" }]);
  const [afterSchema, afterForeignKeys, ...after] = await d1.query(input.source.databaseId, [
    { sql: "SELECT name,sql FROM sqlite_master WHERE type='table' AND name IN ('wiki_legacy_pages','wiki_assets','wiki_links','wiki_contacts') ORDER BY name" },
    { sql: "PRAGMA foreign_key_check" },
    ...legacy.map(name => ({ sql: `SELECT * FROM ${quote(name === "wiki_pages" ? "wiki_legacy_pages" : name)}` })),
  ]);
  if (afterForeignKeys.length || afterSchema.length !== schema.length ||
    after.some((rows, index) => digest(rows) !== archive.digests[legacy[index]]))
    throw Error("Legacy page archive readback failed; do not retry the app upgrade");
  for (const table of afterSchema.filter(row => row.name !== "wiki_legacy_pages"))
    if (!String(table.sql).includes("REFERENCES \"wiki_legacy_pages\""))
      throw Error(`Legacy child foreign key was not renamed: ${table.name}`);
  return { applied: true, counts: counts[0], digests: archive.digests };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [receiptPath, backupPath, flag] = process.argv.slice(2);
  if (!receiptPath || !backupPath || (flag && flag !== "--apply") || !process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.CLOUDFLARE_API_TOKEN)
    throw Error("Usage: CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... node --import tsx scripts/reconcile-legacy-pages.ts receipt.local.json new-backup.local.json [--apply]");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Receipt;
  const d1 = d1Operator(process.env.CLOUDFLARE_ACCOUNT_ID, process.env.CLOUDFLARE_API_TOKEN);
  console.log(await reconcileLegacyPages(d1, { source: receipt.source, destination: receipt.destination, owner: receipt.owner, receipt, backup: backupPath, apply: flag === "--apply" }));
}
