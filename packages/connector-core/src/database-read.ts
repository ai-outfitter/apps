import { z } from "zod";
import { connectorManifestSchema, type Connector } from "./manifest";

export const databaseReadManifestSchema = connectorManifestSchema
  .unwrap()
  .safeExtend({
    contractVersion: z.literal("database.read.v1"),
    operations: z
      .tuple([
        z.literal("sources.list"),
        z.literal("schema.read"),
        z.literal("rows.read"),
      ])
      .readonly(),
    authentication: z
      .object({
        type: z.literal("database-credentials"),
        ownership: z.literal("organization"),
      })
      .strict()
      .readonly(),
  })
  .readonly();
export type DatabaseReadDescriptor = z.infer<typeof databaseReadManifestSchema>;
export interface DatabaseSource {
  id: string;
  name: string;
}
export interface DatabaseColumn {
  name: string;
  type: string;
}
export interface DatabaseRows {
  rows: Record<string, unknown>[];
  coverage:
    { outcome: "complete" } | { outcome: "partial"; reason: "row_limit" };
}
/** IDs are connection-local schema.view identifiers. No arbitrary SQL surface. */
export interface DatabaseReadConnector extends Connector<DatabaseReadDescriptor> {
  listSources(): Promise<{
    items: DatabaseSource[];
    coverage: { outcome: "complete" };
  }>;
  inspectSource(sourceId: string): Promise<{ columns: DatabaseColumn[] }>;
  readRows(input: { sourceId: string; limit?: number }): Promise<DatabaseRows>;
}
