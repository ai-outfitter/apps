import type { AgentDatabase } from "@ai-outfitter/app-sdk/agent-store";
import type { ImportPlan } from "@ai-outfitter/app-sdk/data-transfer";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import type { Graph } from "../lib/graph";
import { graphBatchGuard } from "./graph-batch";
import { validateGraphImport } from "./data-transfer";

/** One request's whole-app restore guard. Never share this closure across requests.
 * The SDK owns preview/revision checks; Onto additionally guards graph-wide rules. */
export function guardedArchive(db: AgentDatabase, read: () => Promise<Graph>, who: AppIdentity) {
  let snapshot: Graph | undefined;
  const database: AgentDatabase = {
    query: statement => db.query(statement),
    async batch(statements) {
      if (!snapshot) throw new Response("Import graph validation is required", { status: 409 });
      const id = `archive-snapshot:${crypto.randomUUID()}`;
      const guard = new SQLiteSyncDialect().sqlToQuery(graphBatchGuard(snapshot, who.userId, id));
      // Keep SDK PRAGMAs first; everything else, including the guard, shares one transaction.
      const pragmas = statements.filter(statement => /^PRAGMA\s/i.test(statement.sql));
      const writes = statements.filter(statement => !/^PRAGMA\s/i.test(statement.sql));
      try {
        return await db.batch([...pragmas, { sql: guard.sql, params: guard.params }, ...writes,
          { sql: "DELETE FROM graph_changes WHERE userId=? AND requestKey=?", params: [who.userId, id] }]);
      } catch (error) {
        if (String(error).includes("graph_changes.attempt"))
          throw new Response("Graph changed during archive validation; preview and retry the import", { status: 409 });
        throw error;
      }
    },
  };
  return { database, async validate(_db: AgentDatabase, plan: ImportPlan) {
    snapshot = await read();
    await validateGraphImport(database, plan);
  } };
}
