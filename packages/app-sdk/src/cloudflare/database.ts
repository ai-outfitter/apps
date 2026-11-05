import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";

/**
 * This installation's own D1 database. Install and upgrade create it, apply
 * the app's migrations and bind it as `DB` (docs/app-databases.md).
 */
const binding = () => (env as unknown as { DB?: D1Database }).DB;

/** `ok` once the bound database answers; demo packages have none. */
export async function databaseHealth() {
  const database = binding();
  if (!database) return "none";
  await database.prepare("SELECT 1").first();
  return "ok";
}

export function installationDatabase() {
  const database = binding();
  if (!database)
    throw new Response("This installation has no database. Redeploy it.", {
      status: 503,
    });
  return drizzle(database);
}

/** Prepared batch adapter: atomic on D1, compatible with libSQL test executors. */
export function agentDatabase(): import("../agent-store").AgentDatabase {
  const db = binding();
  if (!db)
    throw new Response("Installation database unavailable", { status: 503 });
  const prepare = (s: import("../agent-store").AgentStatement) =>
    db.prepare(s.sql).bind(...(s.params ?? []));
  return {
    query: async (s) =>
      (await prepare(s).all<Record<string, unknown>>()).results,
    batch: async (steps) => {
      await db.batch(steps.map(prepare));
    },
  };
}
