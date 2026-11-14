import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import type { AgentStatement } from "@ai-outfitter/app-sdk/agent-store";
import type { WikiGraph } from "@ai-outfitter/app-sdk/graph-contracts";
import type { Graph } from "../lib/graph";
import type { OntologyGraph } from "../lib/ontology-model";
import { readType } from "../lib/type-metadata";
import { requireOntologyValid } from "../lib/ontology-validation";
import { graphBatchGuard } from "./graph-batch";

type Row = Record<string, unknown>;
const decode = (value: unknown) =>
  typeof value === "string" ? JSON.parse(value) : value;
export function seedSnapshot(stored: Row[][]): OntologyGraph {
  const types = stored[0].map((row) =>
    readType({
      ...row,
      id: String(row.id),
      archived: Boolean(row.archived),
      category: row.category as "node" | "edge",
      revision: Number(row.revision),
      properties: decode(row.properties),
    }),
  );
  return {
    types: types as OntologyGraph["types"],
    nodes: stored[1].map((row) => ({
      ...row,
      archived: Boolean(row.archived),
      validity: decode(row.validity) ?? null,
    })) as OntologyGraph["nodes"],
    edges: stored[2].map(({ validFrom, validTo, ...row }) => ({
      ...row,
      archived: Boolean(row.archived),
      validity: validFrom || validTo ? { from: validFrom ?? null, to: validTo ?? null } : null,
    })) as OntologyGraph["edges"],
  };
}
export function validateSeedAdditions(
  before: OntologyGraph,
  additions: WikiGraph,
  upgrades: WikiGraph["types"] = [],
) {
  const replaced = new Map(upgrades.map((type) => [type.id, type]));
  const after = {
    types: [...before.types.map((type) => replaced.get(type.id) ?? type), ...additions.types],
    nodes: [...before.nodes, ...additions.nodes],
    edges: [...before.edges, ...additions.edges],
  };
  requireOntologyValid(
    before,
    after,
    new Map(
      [...additions.types, ...upgrades, ...additions.nodes, ...additions.edges].map(
        (row) => [row.id, `$seed-${row.id}`],
      ),
    ),
  );
}
export function seedGuard(
  before: OntologyGraph,
  userId: string,
  guardId: string,
): AgentStatement {
  const query = new SQLiteSyncDialect().sqlToQuery(graphBatchGuard(before as Graph, userId, guardId));
  return { sql: query.sql, params: query.params };
}
