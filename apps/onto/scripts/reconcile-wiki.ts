/** Explicit, source-bound reconciliation for the trusted operator migration. */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { standardData } from "../src/lib/standard-data";
export const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
export function sourceTables(db: DatabaseSync) {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  )
    .filter(
      (r) =>
        ![
          "_outfitter_migrations",
          "__drizzle_migrations",
          "d1_migrations",
          "_cf_KV",
        ].includes(r.name),
    )
    .map(({ name }) => ({
      name,
      columns: db
        .prepare(`PRAGMA table_info(${quote(name)})`)
        .all()
        .map((r) => String(r.name)),
      rows: db.prepare(`SELECT * FROM ${quote(name)}`).all(),
    }));
}
export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function sourceDigest(db: DatabaseSync) {
  return digest(
    sourceTables(db).map((t) => ({
      ...t,
      rows: t.rows.map((row) => JSON.stringify(row)).sort(),
    })),
  );
}
export type Reconciliation = {
  format: "wiki-onto-reconciliation-v1";
  sourceDigest: string;
  createdAt: number;
  actor: string;
  seedAliases: Record<string, string>;
  types: Record<string, { before: string; properties: string; reason: string }>;
};
export function reconcileWiki(db: DatabaseSync, actor: string): Reconciliation {
  const types = db.prepare("SELECT * FROM graph_types").all();
  const nodes = new Map(
    db
      .prepare("SELECT id,typeId FROM graph_nodes")
      .all()
      .map((row) => [String(row.id), String(row.typeId)]),
  );
  const edges = db.prepare("SELECT * FROM graph_edges").all();
  const plan: Reconciliation = {
    format: "wiki-onto-reconciliation-v1",
    sourceDigest: sourceDigest(db),
    createdAt: Date.now(),
    actor,
    seedAliases: {},
    types: {},
  };
  for (const seed of standardData.types) {
    const source = types.find((t) => t.name === seed.name);
    if (source && source.id !== seed.id) {
      if (source.category !== seed.category)
        throw Error(`Incompatible type category for ${seed.name}`);
      plan.seedAliases[seed.id] = String(source.id);
    }
  }
  for (const type of types) {
    if (type.category !== "edge") continue;
    const original = String(type.properties),
      parsed = JSON.parse(original);
    const stored = Array.isArray(parsed) ? { fields: parsed } : parsed;
    if (stored.ontology?.endpoints || stored.ontology?.projection) continue;
    const seed = standardData.types.find(
      (seed) => seed.id === type.id || seed.name === type.name,
    );
    const proposed = seed?.ontology?.endpoints;
    const remap = (side: "any" | string[]): "any" | string[] =>
      side === "any" ? "any" : side.map((id) => plan.seedAliases[id] ?? id);
    let endpoints:
      { from: "any" | string[]; to: "any" | string[] } | undefined = proposed
      ? { from: remap(proposed.from), to: remap(proposed.to) }
      : undefined;
    const allowed = (side: "any" | string[], id: string | undefined) =>
      id && (side === "any" || side.includes(id));
    const compatible =
      endpoints &&
      edges
        .filter((edge) => edge.typeId === type.id)
        .every(
          (edge) =>
            allowed(endpoints!.from, nodes.get(String(edge.fromId))) &&
            allowed(endpoints!.to, nodes.get(String(edge.toId))),
        );
    const reason = compatible
      ? "Declared seed endpoints accept every preserved legacy relationship."
      : proposed
        ? "Retain legacy unconstrained endpoints: the newer seed would reject preserved relationships."
        : "Make the existing unconstrained legacy endpoint semantics explicit.";
    if (!compatible) endpoints = { from: "any", to: "any" };
    plan.types[String(type.id)] = {
      before: original,
      properties: JSON.stringify({
        ...stored,
        ontology: { ...(stored.ontology ?? { version: 2 }), endpoints },
      }),
      reason,
    };
  }
  return plan;
}
