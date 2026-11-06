import { z } from "zod";
import { connectorManifestSchema } from "./manifest";
import type { ConnectorOperation, RuntimeConnector } from "./runtime";

// Imported connectors read data the platform holds for a connection, not a
// provider API: a member uploads an export (Apple Health, Messages) or a paired
// device pushes batches. The package owns the record schemas and the reads; the
// platform owns storage and lends a store bound to one connection per call.

/** A record's own id: stable for the same fact, so importing it again replaces it. */
export const recordId = z.string().min(1).max(256);
/** Unix milliseconds the fact happened (a message sent, a sample started). */
export const recordTime = z.number().int().min(0).max(8_640_000_000_000_000);

/** One stored record. `subject` is its secondary key (a chat, a metric) that reads filter on. */
export type ImportedRecord = { kind: string; id: string; subject: string | null; occurredAt: number | null; value: unknown };

/** An imported connection's config: where its records last came from, and how many it holds. */
export const importedConfig = z.object({
  source: z.enum(["export", "device"]),
  importedAt: z.number().int(),
  records: z.number().int().min(0).optional(),
});

/** An imported connector: one personal connection per member, no secret, and
 * the member's whole import (the connection's externalId) as the grant
 * resource. `authorizeConnector` already checks provider, status and owner. */
export function importedConnector(id: string, displayName: string, operations: Record<string, ConnectorOperation>): RuntimeConnector {
  return {
    descriptor: connectorManifestSchema.parse({
      schemaVersion: 1, id, displayName, implementationVersion: "0.1.0", contractVersion: "connector.runtime.v1",
      operations: Object.keys(operations),
      connection: { accountsPerOwner: "one", accountSharing: "exclusive" },
      authentication: { type: "imported", ownership: "user" },
    }),
    config: importedConfig,
    events: {},
    verifyWebhook: null,
    coversResource: async (connection, resource) => resource === connection.externalId,
    operations,
  };
}

/** At most this many records in one upload or device batch. */
export const IMPORT_BATCH_LIMIT = 1000;

export type ImportedRecordQuery = {
  kind: string;
  subject?: string;
  /** Inclusive lower and exclusive upper bound on `occurredAt`. */
  from?: number;
  to?: number;
  /** A previous page's `cursor`. */
  cursor?: string;
  limit: number;
  /** By `occurredAt`, then id. Default newest first. */
  order?: "asc" | "desc";
};

export type ImportedSubjectSummary = { kind: string; subject: string | null; count: number; first: number | null; last: number | null };

/** The platform's records of one connection. Implementations never cross connections. */
export interface ImportedRecordStore {
  list(query: ImportedRecordQuery): Promise<{ records: ImportedRecord[]; cursor: string | null }>;
  /** Count and time range of each kind and subject the connection holds. */
  summary(): Promise<ImportedSubjectSummary[]>;
}

/** For the broker catalog: describes operations but cannot read. The platform
 * runs imported connectors in-process with a store bound to the granted connection. */
const unbound = () => Promise.reject(new Response("Imported records are read by the platform", { status: 503 }));
export const unboundImportedStore: ImportedRecordStore = { list: unbound, summary: unbound };

/** A page query's shared input: a time window, a page size and a cursor. */
export const windowInput = {
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  order: z.enum(["asc", "desc"]).optional(),
};

/** The store query for a window input. */
export function windowQuery(kind: string, input: { from?: string; to?: string; cursor?: string; limit?: number; order?: "asc" | "desc" }, subject?: string): ImportedRecordQuery {
  return {
    kind, ...(subject ? { subject } : {}),
    ...(input.from ? { from: Date.parse(input.from) } : {}), ...(input.to ? { to: Date.parse(input.to) } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}), limit: input.limit ?? 100, order: input.order ?? "desc",
  };
}

/** ISO time of a record's `occurredAt`, or null. */
export const isoTime = (at: number | null) => (at === null ? null : new Date(at).toISOString());
