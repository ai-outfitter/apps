import type { AgentDatabase } from "@ai-outfitter/app-sdk/agent-store";
import type { ImportPlan } from "@ai-outfitter/app-sdk/data-transfer";

type Row = Record<string, unknown>;

/** Graph references a generic row import could break once local records are kept. Unique indexes (slugs, type names) are checked by the SDK. */
export async function validateGraphImport(db: AgentDatabase, plan: ImportPlan) {
  const incoming = (table: string): Row[] => {
    const found = plan.tables.find((t) => t.table === table);
    return found ? found.writes.map((row) => Object.fromEntries(found.columns.map((c, i) => [c, row[i]]))) : [];
  };
  // Destination rows whose `column` is one of `values`.
  const lookup = async (table: string, column: string, values: unknown[]) => {
    const wanted = [...new Set(values.map(String))];
    const rows: Row[] = [];
    for (let i = 0; i < wanted.length; i += 90) {
      const chunk = wanted.slice(i, i + 90);
      rows.push(...await db.query({ sql: `SELECT id, ${column} AS value FROM ${table} WHERE ${column} IN (${chunk.map(() => "?").join(",")})`, params: chunk }));
    }
    return rows;
  };
  const types = incoming("graph_types"), nodes = incoming("graph_nodes"), edges = incoming("graph_edges");

  const typeIds = new Set([...types, ...await lookup("graph_types", "id", [...nodes, ...edges].map((r) => r.typeId))].map((r) => String(r.id)));
  for (const row of [...nodes, ...edges])
    if (!typeIds.has(String(row.typeId))) throw new Response(`Record ${row.id} uses a type this Wiki lacks`, { status: 409 });

  const nodeIds = new Set([...nodes, ...await lookup("graph_nodes", "id", edges.flatMap((e) => [e.fromId, e.toId]))].map((r) => String(r.id)));
  for (const edge of edges)
    if (!nodeIds.has(String(edge.fromId)) || !nodeIds.has(String(edge.toId)))
      throw new Response(`Relationship ${edge.id} points at a record this Wiki lacks`, { status: 409 });
}
