import { z } from "zod";
import { connectorManifestSchema, type Connector } from "./manifest";

export const chatReadManifestSchema = connectorManifestSchema
  .unwrap()
  .safeExtend({
    contractVersion: z.literal("chat.read.v1"),
    authentication: z
      .object({ type: z.literal("oauth2"), ownership: z.literal("user") })
      .strict()
      .readonly(),
    operations: z
      .tuple([
        z.literal("sources.list"),
        z.literal("history.read"),
        z.literal("thread.read"),
      ])
      .readonly(),
  })
  .readonly();

export type ChatReadDescriptor = z.infer<typeof chatReadManifestSchema>;

export type ReadCoverage =
  | { outcome: "complete" }
  | { outcome: "partial"; reason: "page_limit" | "provider_error" }
  | { outcome: "rate_limited"; retryAfterSeconds: number }
  | { outcome: "revoked" };

export interface ReadSource {
  id: string;
  name: string;
}

export interface ReadRecord {
  id: string;
  sourceId: string;
  timestamp: string;
  authorId: string | null;
  text: string;
  threadId: string | null;
  reference: string;
}

export interface ReadPage<T> {
  items: T[];
  coverage: ReadCoverage;
}

/** Provider-neutral read surface consumed by apps. Implementations returned by
 * authorization services recheck authority for every operation. */
export interface ChatReadConnector extends Connector<ChatReadDescriptor> {
  listSources(): Promise<ReadPage<ReadSource>>;
  readHistory(input: {
    sourceId: string;
    oldest?: string;
    latest?: string;
    maxPages?: number;
  }): Promise<ReadPage<ReadRecord>>;
  readThread(input: {
    sourceId: string;
    threadId: string;
    maxPages?: number;
  }): Promise<ReadPage<ReadRecord>>;
}
