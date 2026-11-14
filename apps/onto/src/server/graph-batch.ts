import { sql, type SQL } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import type { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { Graph } from "../lib/graph";
import { graphUnchanged, type Database } from "./graph";

/** A failed snapshot forces transaction rollback before any graph statement. */
export function graphBatchGuard(graph: Graph, userId: string, guardId: string) {
  return sql`INSERT INTO graph_changes(userId,requestKey,hash,attempt,receipt)
    VALUES(${userId},${guardId},'snapshot',CASE WHEN ${graphUnchanged(graph)} THEN ${guardId} ELSE NULL END,'{}')`;
}

export async function guardedGraphBatch(db: Database, who: AppIdentity, graph: Graph, statements: SQL[], message: string) {
  const guardId = `snapshot:${crypto.randomUUID()}`;
  const queries = [graphBatchGuard(graph, who.userId, guardId), ...statements,
    sql`DELETE FROM graph_changes WHERE userId=${who.userId} AND requestKey=${guardId}`];
  // Wiki's operational and local-development stores both use the D1 adapter.
  const client = (db as ReturnType<typeof installationDatabase>).$client;
  try {
    await client.batch(queries.map((query) => {
      const compiled = new SQLiteSyncDialect().sqlToQuery(query);
      return client.prepare(compiled.sql).bind(...compiled.params);
    }));
  } catch (error) {
    if (String(error).includes("graph_changes.attempt")) throw new Response(message, { status: 409 });
    throw error;
  }
}
