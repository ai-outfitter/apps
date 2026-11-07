// A KnowledgeGraph with a selection stores the GraphQL document that selection
// compiles to (`query`, `hash`, `variables`), so any client (a page, an agent) can run
// it by hash. What a selection compiles to depends on the Wiki's types: a rule whose
// type is absent compiles to nothing, and an app may add that type later (Planning
// adds UseCase). So whenever types change, the stored documents are recompiled here.
import { and, eq, sql } from "drizzle-orm";
import { core } from "../lib/graph";
import { withCompiledQuery } from "../lib/knowledge-graph-document";
import type { Database } from "./graph";
import { databaseSource } from "./graph-source";
import { graphNodes, graphTypes } from "./schema";
import { readType } from "../lib/type-metadata";

/** Rewrite the stored document of every active KnowledgeGraph whose selection now compiles
 * to different text. Authorship stays: this is derived data, not an edit, so a seed or
 * admin document stays trusted. */
export async function refreshKnowledgeGraphQueries(db: Database) {
  const [storedType] = await db.select().from(graphTypes).where(eq(graphTypes.id, core.knowledgeGraph));
  if (storedType) {
    const type = readType(storedType);
    const ontology = "ontology" in type ? type.ontology : undefined;
    if (ontology?.version === 2 && ontology.immutable) return 0;
  }
  const types = await databaseSource(db).types();
  const rows = await db.select().from(graphNodes).where(and(eq(graphNodes.typeId, core.knowledgeGraph), eq(graphNodes.archived, false)));
  let refreshed = 0;
  for (const row of rows) {
    const next = withCompiledQuery(row, types);
    if (next === row) continue;
    const updated = await db.update(graphNodes).set({ body: next.body, revision: row.revision + 1, updatedAt: Date.now() })
      .where(and(eq(graphNodes.id, row.id), eq(graphNodes.revision, row.revision), sql`not exists (select 1 from graph_types where id = ${core.knowledgeGraph} and json_extract(properties, '$.ontology.immutable') = 1)`)).returning({ id: graphNodes.id });
    refreshed += updated.length;
  }
  return refreshed;
}
