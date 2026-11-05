/** A parameterized statement for an installation database adapter (`agentDatabase()` and app-owned stores). */
export type AgentStatement = { sql: string; params?: unknown[] };
/** An installation database: queries, and `batch` as one atomic write transaction. */
export type AgentDatabase = {
  query(statement: AgentStatement): Promise<Record<string, unknown>[]>;
  batch(statements: AgentStatement[]): Promise<unknown>;
};
