import type { AgentDatabase } from "@ai-outfitter/app-sdk/agent-store";
import type { ImportPlan } from "@ai-outfitter/app-sdk/data-transfer";

type Row = Record<string, unknown>;

/** Graph references a generic row import could break once local records are kept. Unique indexes (slugs, type names) are checked by the SDK. */
export async function validateGraphImport(db: AgentDatabase, plan: ImportPlan) {
  const incoming = (table: string): Row[] => {
    const found = plan.tables.find((t) => t.table === table);
    return found ? found.writes.map((row) => Object.fromEntries(found.columns.map((c, i) => [c, row[i]]))) : [];
  };
  // Keep a portable hold so a blocked proposal remains blocked after transfer.
  // Only the authorized local API can establish reviewer identity and history.
  const proposals = plan.tables.find(table => table.table === "graph_batch_operations");
  const decision = proposals?.columns.indexOf("decision") ?? -1;
  const decidedBy = proposals?.columns.indexOf("decidedBy") ?? -1;
  for (const row of proposals?.writes ?? []) {
    const value = row[decision];
    if (typeof value !== "string") continue;
    let parsed: { verdict?: unknown; comment?: unknown } | null;
    try { parsed = JSON.parse(value); }
    catch { throw new Response("Invalid proposal decision in archive", { status: 400 }); }
    if (parsed?.verdict === "request_changes") {
      row[decision] = JSON.stringify({
        kind: "imported", verdict: "request_changes",
        ...(typeof parsed.comment === "string" && { comment: parsed.comment.slice(0, 2000) }),
      });
      if (decidedBy >= 0) row[decidedBy] = null;
    }
  }
  // The archive cannot supply the immutable submission rows. Derive version
  // pointers only from the destination's own submission history.
  const batches = plan.tables.find(table => table.table === "graph_batches");
  const version = batches?.columns.indexOf("submittedVersion") ?? -1;
  if (batches && version >= 0) {
    const id = batches.columns.indexOf("id");
    for (let start = 0; start < batches.writes.length; start += 90) {
      const rows = batches.writes.slice(start, start + 90);
      const local = await db.query({
        sql: `SELECT batchId, MAX(version) AS version FROM graph_batch_submissions WHERE batchId IN (${rows.map(() => "?").join(",")}) GROUP BY batchId`,
        params: rows.map(row => row[id]),
      });
      const versions = new Map(local.map(row => [row.batchId, Number(row.version)]));
      for (const row of rows) row[version] = versions.get(row[id]) ?? 0;
    }
  }
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
  const editedBatches = [...new Set([
    ...incoming("graph_batches").map(row => String(row.id)),
    ...incoming("graph_batch_operations").map(row => String(row.batchId)),
  ])];
  if (editedBatches.length) {
    const [existing] = await db.query({
      sql: "SELECT 1 FROM onto_passage_suggestions WHERE batchId IN (SELECT value FROM json_each(?)) LIMIT 1",
      params: [JSON.stringify(editedBatches)],
    });
    if (existing) throw new Response("Portable imports cannot amend local Wiki passage reviews", { status: 409 });
  }

  const types = incoming("graph_types"), nodes = incoming("graph_nodes"), edges = incoming("graph_edges");

  const typeIds = new Set([...types, ...await lookup("graph_types", "id", [...nodes, ...edges].map((r) => r.typeId))].map((r) => String(r.id)));
  for (const row of [...nodes, ...edges])
    if (!typeIds.has(String(row.typeId))) throw new Response(`Record ${row.id} uses a type this Wiki lacks`, { status: 409 });

  const nodeIds = new Set([...nodes, ...await lookup("graph_nodes", "id", edges.flatMap((e) => [e.fromId, e.toId]))].map((r) => String(r.id)));
  for (const edge of edges)
    if (!nodeIds.has(String(edge.fromId)) || !nodeIds.has(String(edge.toId)))
      throw new Response(`Relationship ${edge.id} points at a record this Wiki lacks`, { status: 409 });
}
