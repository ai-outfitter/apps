// A KnowledgeGraph with a selection stores the GraphQL document that selection
// compiles to (`query`, `hash`, `variables`), so any client (a page, an agent) can run
// it by hash. What a selection compiles to depends on the Wiki's types: a rule whose
// type is absent compiles to nothing, and an app may add that type later (Planning
// adds UseCase). So whenever types change, the stored documents are recompiled here.
import { and, eq } from "drizzle-orm";
import { core } from "../lib/graph";
import { withCompiledQuery } from "../lib/knowledge-graph-document";
import type { Database } from "./graph";
import { databaseSource } from "./graph-source";
import { graphNodes } from "./schema";

/** Rewrite the stored document of every active KnowledgeGraph whose selection now compiles
 * to different text. Authorship stays: this is derived data, not an edit, so a seed or
 * admin document stays trusted. */
export async function refreshKnowledgeGraphQueries(db: Database) {
  const types = await databaseSource(db).types();
  const rows = await db.select().from(graphNodes).where(and(eq(graphNodes.typeId, core.knowledgeGraph), eq(graphNodes.archived, false)));
  let refreshed = 0;
  for (const row of rows) {
    const next = withCompiledQuery(row, types);
    if (next === row) continue;
    const updated = await db.update(graphNodes).set({ body: next.body, revision: row.revision + 1, updatedAt: Date.now() })
      .where(and(eq(graphNodes.id, row.id), eq(graphNodes.revision, row.revision))).returning({ id: graphNodes.id });
    refreshed += updated.length;
  }
  return refreshed;
}
