import { wikiGraph } from "@ai-outfitter/app-sdk/wiki";
import type {
  AgentDatabase,
  AgentStatement,
} from "@ai-outfitter/app-sdk/agent-store";
import { requireEditor, type AppIdentity } from "@ai-outfitter/app-sdk/server";
import { standardData, validateSeed } from "../lib/standard-data";
import { storeType } from "../lib/type-metadata";
import {
  seedSnapshot,
  seedGuard,
  validateSeedAdditions,
} from "./ontology-seeds";
import { typeInput } from "../lib/graph";
import { knowledgeGraphTypeId } from "@ai-outfitter/app-sdk/graph-selection";

type Row = { id: string; [key: string]: unknown };
const insert = (
  table: string,
  row: Record<string, unknown>,
): AgentStatement => ({
  sql: `INSERT INTO ${table} (${Object.keys(row)
    .map((key) => `"${key}"`)
    .join(",")}) VALUES (${Object.keys(row)
    .map(() => "?")
    .join(",")}) ON CONFLICT(id) DO NOTHING`,
  params: Object.values(row).map((value) =>
    typeof value === "boolean"
      ? Number(value)
      : value !== null && typeof value === "object"
        ? JSON.stringify(value)
        : value,
  ),
});

// seed:knowledge-graphs-v1 created the KnowledgeGraph type and lens_for in migration 0001.
const seedActors = ["seed:types-v1", "seed:wiki-standard-data", "seed:knowledge-graphs-v1"];
const contractColumns = ["title", "body", "properties"] as const;
const stored = (value: unknown) =>
  value !== null && typeof value === "object" ? JSON.stringify(value) : value;
const decoded = (row: Record<string, unknown>, column: (typeof contractColumns)[number]) =>
  column === "properties" ? JSON.stringify(JSON.parse(String(row[column]))) : row[column];

/** Seed-owned types nobody has edited (only seed setup ever wrote them) follow
 * the current seed contract. Like any type edit, the upgrade bumps the revision
 * so stale writers get a conflict. Edited and archived types stay as they are. */
function contractUpgrades(data: typeof standardData, rows: Record<string, unknown>[], audit: { updatedBy: string; updatedAt: number }) {
  if (data !== standardData) return [];
  const current = new Map(rows.map((row) => [row.id, row]));
  return data.types.flatMap((type) => {
    const row = current.get(type.id);
    if (!row || row.archived || row.category !== type.category || row.name !== type.name || !seedActors.includes(String(row.createdBy)) || !seedActors.includes(String(row.updatedBy))) return [];
    const next = storeType(typeInput.parse(type));
    if (contractColumns.every((column) => decoded(row, column) === stored(next[column]))) return [];
    return [{ type, statement: {
      sql: `UPDATE graph_types SET title=?, body=?, properties=?, revision=revision+1, updatedBy=?, updatedAt=?
        WHERE id=? AND revision=? AND archived=0 AND updatedBy=?`,
      params: [...contractColumns.map((column) => stored(next[column])), audit.updatedBy, audit.updatedAt, type.id, row.revision, row.updatedBy],
    } as AgentStatement }];
  });
}

const knowledgeGraphColumns = ["title", "summary", "body", "properties"] as const;
/** Two KnowledgeGraph bodies are the same when they differ at most in the document compiled
 * from their selection, which follows the Wiki's types (knowledge-graph-refresh.ts) rather
 * than the seed. A stored selection with no compiled document yet differs, so the seed fills it in. */
function sameBody(stored: unknown, seed: unknown) {
  try {
    const [row, next] = [stored, seed].map((body) => JSON.parse(String(body ?? "")));
    if (!row?.selection || !row.query) throw new Error("not compiled");
    const authored = ({ query: _query, hash: _hash, variables: _variables, ...rest }: Record<string, unknown>) => JSON.stringify(rest);
    return authored(row) === authored(next);
  } catch { return String(stored ?? "") === String(seed ?? ""); }
}
/** Seed KnowledgeGraph definitions nobody has edited follow the current seed (for
 * example its compiled `query`), with a revision bump. Edited and archived ones stay. */
function knowledgeGraphUpgrades(data: typeof standardData, rows: Record<string, unknown>[], audit: { updatedBy: string; updatedAt: number }): AgentStatement[] {
  if (data !== standardData) return [];
  const current = new Map(rows.map((row) => [row.id, row]));
  return data.nodes.flatMap((node) => {
    const row = current.get(node.id);
    if (node.typeId !== knowledgeGraphTypeId || node.archived || !row || row.archived || row.typeId !== node.typeId
      || !seedActors.includes(String(row.createdBy)) || !seedActors.includes(String(row.updatedBy))) return [];
    const next = node as unknown as Record<string, unknown>;
    const same = (column: (typeof knowledgeGraphColumns)[number]) => column === "properties"
      ? JSON.stringify(JSON.parse(String(row.properties ?? "{}"))) === JSON.stringify(next.properties ?? {})
      : column === "body" ? sameBody(row.body, next.body)
      : String(row[column] ?? "") === String(next[column] ?? "");
    if (knowledgeGraphColumns.every(same)) return [];
    return [{
      sql: `UPDATE graph_nodes SET title=?, summary=?, body=?, properties=?, revision=revision+1, updatedBy=?, updatedAt=?
        WHERE id=? AND revision=? AND archived=0 AND updatedBy=?`,
      params: [...knowledgeGraphColumns.map((column) => stored(next[column] ?? (column === "properties" ? {} : ""))), audit.updatedBy, audit.updatedAt, node.id, row.revision, row.updatedBy],
    }];
  });
}

// A contract upgrade that existing records would violate is skipped, so setup
// never fails on data the previous contract allowed.
function upgradesKeepingData(before: ReturnType<typeof seedSnapshot>, additions: ReturnType<typeof wikiGraph.parse>, upgrades: ReturnType<typeof contractUpgrades>) {
  if (!upgrades.length) return [];
  try {
    validateSeedAdditions(before, additions, upgrades.map(({ type }) => type));
  } catch (error) {
    if (error instanceof Response) return [];
    throw error;
  }
  return upgrades.map(({ statement }) => statement);
}

// Defer incompatible optional standard nodes, then revalidate the reduced graph.
async function validatedUpgrades(before: ReturnType<typeof seedSnapshot>, added: Row[][], upgrades: ReturnType<typeof contractUpgrades>, data: typeof standardData) {
  for (;;) {
    const additions = wikiGraph.parse({ types: added[0], nodes: added[1], edges: added[2] });
    const safeUpgrades = upgradesKeepingData(before, additions, upgrades);
    try {
      if (!safeUpgrades.length) validateSeedAdditions(before, additions);
      return safeUpgrades;
    } catch (error) {
      if (data !== standardData || !(error instanceof Response) || error.status !== 400) throw error;
      const result = await error.clone().json() as { code?: string; errors?: { recordId?: string; rule?: string }[] };
      const nodes = new Set(added[1].map((node) => node.id));
      if (result.code !== "ontology_validation_failed" || !result.errors?.length ||
          result.errors.some((issue) => issue.rule !== "body.schema" || !nodes.has(String(issue.recordId)))) throw error;
      const deferred = new Set(result.errors.map((issue) => issue.recordId));
      added[1] = added[1].filter((node) => !deferred.has(node.id));
      added[2] = added[2].filter((edge) => !deferred.has(String(edge.fromId)) && !deferred.has(String(edge.toId)));
    }
  }
}

/** Repeatable JSON setup adds missing records and refreshes known, untouched
 * seed type contracts. Authored records and archives stay untouched. */
export async function setupStandardData(
  database: AgentDatabase,
  who: AppIdentity,
  data = standardData,
) {
  requireEditor(who);
  if (data !== standardData) validateSeed(data);
  const tables = ["graph_types", "graph_nodes", "graph_edges"] as const;
  const stored = await Promise.all(
    tables.map((table) =>
      database.query({
        sql: `SELECT * FROM ${table}`,
      }),
    ),
  );
  const groups: { table: string; records: Row[]; existing: Set<unknown> }[] = [
    {
      table: tables[0],
      records: data.types,
      existing: new Set(stored[0].map((row) => row.id)),
    },
    {
      table: tables[1],
      records: data.nodes,
      existing: new Set(stored[1].map((row) => row.id)),
    },
    {
      table: tables[2],
      records: data.edges,
      existing: new Set(stored[2].map((row) => row.id)),
    },
  ];
  // Authored nodes keep their addresses. Do not replace them with sample data
  // or attach sample relationships to an unrelated record sharing a slug.
  const existingNodes = new Set(stored[1].map((row) => row.id));
  const existingSlugs = new Set(stored[1].map((row) => row.slug));
  const skippedNodes = new Set(
    data.nodes
      .filter(
        (node) => !existingNodes.has(node.id) && existingSlugs.has(node.slug),
      )
      .map((node) => node.id),
  );
  // A type a Wiki created itself before the seed shipped one (evidence_for from
  // evidence bundles) keeps its ID; type names are unique, so the seed's copy is skipped.
  const existingTypeNames = new Set(stored[0].map((row) => row.name));
  const skippedTypes = new Set(
    data.types
      .filter((type) => !groups[0].existing.has(type.id) && existingTypeNames.has(type.name))
      .map((type) => type.id),
  );
  for (const node of data.nodes) if (skippedTypes.has(node.typeId)) skippedNodes.add(node.id);
  const now = Date.now();
  const audit = {
    revision: 1,
    createdBy: "seed:wiki-standard-data",
    updatedBy: "seed:wiki-standard-data",
    createdAt: now,
    updatedAt: now,
  };
  const added = groups.map(({ table, records, existing }) =>
    records
      .filter((record) => !existing.has(record.id))
      .filter((record) =>
        table === "graph_types"
          ? !skippedTypes.has(record.id)
          : table === "graph_nodes"
            ? !skippedNodes.has(record.id)
            : !skippedTypes.has(String(record.typeId)) &&
              !skippedNodes.has(String(record.fromId)) &&
              !skippedNodes.has(String(record.toId)),
      ),
  );
  const upgrades = contractUpgrades(data, stored[0], audit);
  const graphUpgrades = knowledgeGraphUpgrades(data, stored[1], audit);
  if (!added.some((records) => records.length) && !upgrades.length && !graphUpgrades.length) return { ok: true };
  const before = seedSnapshot(stored);
  const safeUpgrades = await validatedUpgrades(before, added, upgrades, data);
  const statements = groups.flatMap(({ table }, index) =>
    added[index].map((record) => insert(table, {
      ...(table === "graph_types" ? storeType(typeInput.parse(record)) : record),
      ...audit,
    })),
  );
  statements.push(...safeUpgrades, ...graphUpgrades);
  if (!statements.length) return { ok: true };
  const guardId = `seed:${crypto.randomUUID()}`;
  try {
    await database.batch([
      seedGuard(before, who.userId, guardId),
      ...statements,
      {
        sql: "DELETE FROM graph_changes WHERE userId=? AND requestKey=?",
        params: [who.userId, guardId],
      },
    ]);
  } catch (error) {
    if (String(error).includes("graph_changes.attempt"))
      throw new Response("Graph changed; retry seed setup", { status: 409 });
    throw error;
  }

  return { ok: true };
}
