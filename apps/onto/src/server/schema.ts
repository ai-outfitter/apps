export { graphChangeReceipts } from "@ai-outfitter/app-sdk/batch-receipts";
import type { ValidityInterval } from "@ai-outfitter/onto/contracts";
import type { EntityRef } from "@ai-outfitter/app-sdk/entities";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type { StoredTypeMetadata } from "../lib/type-metadata";
import type { BatchReview } from "./batch-review";

export const graphTypes = sqliteTable("graph_types", {
  id: text().primaryKey(),
  category: text({ enum: ["node", "edge"] }).notNull(),
  name: text().notNull().unique(),
  title: text().notNull(),
  body: text().notNull(),
  properties: text({ mode: "json" }).$type<StoredTypeMetadata>().notNull(),
  archived: integer({ mode: "boolean" }).notNull().default(false),
  seedVersion: integer(),
  revision: integer().notNull().default(1),
  createdBy: text(),
  updatedBy: text(),
  createdAt: integer().notNull(),
  updatedAt: integer().notNull(),
});

// Clean typed graph. Type definitions bootstrap the model; no per-domain tables.
export const graphNodes = sqliteTable(
  "graph_nodes",
  {
    id: text().primaryKey(),
    typeId: text()
      .notNull()
      .references(() => graphTypes.id),
    slug: text().notNull(),
    title: text().notNull(),
    summary: text().notNull().default(""),
    body: text().notNull().default(""),
    website: text(),
    validity: text({ mode: "json" }).$type<ValidityInterval>(),
    properties: text({ mode: "json" })
      .$type<Record<string, string | number | boolean | null>>()
      .notNull()
      .default({}),
    source: text({ mode: "json" }).$type<EntityRef>(),
    externalProvider: text(),
    externalId: text(),
    archived: integer({ mode: "boolean" }).notNull().default(false),
    revision: integer().notNull().default(1),
    createdBy: text(),
    updatedBy: text(),
    createdAt: integer().notNull(),
    updatedAt: integer().notNull(),
  },
  (t) => [
    uniqueIndex("graph_nodes_type_slug").on(t.typeId, t.slug),
    uniqueIndex("graph_nodes_source_idx").on(t.source),
    uniqueIndex("graph_nodes_external_identity_idx").on(
      t.externalProvider,
      t.externalId,
    ),
  ],
);

export const graphEdges = sqliteTable(
  "graph_edges",
  {
    id: text().primaryKey(),
    typeId: text()
      .notNull()
      .references(() => graphTypes.id),
    fromId: text()
      .notNull()
      .references(() => graphNodes.id),
    toId: text()
      .notNull()
      .references(() => graphNodes.id),
    title: text().notNull().default(""),
    body: text().notNull().default(""),
    properties: text({ mode: "json" })
      .$type<Record<string, string | number | boolean | null>>()
      .notNull()
      .default({}),
    archived: integer({ mode: "boolean" }).notNull().default(false),
    revision: integer().notNull().default(1),
    createdBy: text(),
    updatedBy: text(),
    createdAt: integer().notNull(),
    updatedAt: integer().notNull(),
    /** When the edge held: from inclusive, until exclusive; null is unbounded. */
    validFrom: text(),
    validTo: text(),
  },
  (t) => [
    index("graph_edges_out").on(t.fromId, t.typeId, t.toId),
    index("graph_edges_in").on(t.toId, t.typeId, t.fromId),
    uniqueIndex("graph_edges_identity")
      .on(t.typeId, t.fromId, t.toId, sql`coalesce(${t.validFrom}, '')`)
      .where(sql`${t.archived} = 0`),
  ],
);

export const graphAssets = sqliteTable("graph_assets", {
  id: text().primaryKey(),
  pageId: text()
    .notNull()
    .references(() => graphNodes.id),
  key: text().notNull().unique(),
  filename: text().notNull(),
  contentType: text().notNull(),
  size: integer().notNull(),
  createdBy: text(),
  createdAt: integer().notNull(),
});

/** Durable receipts are scoped to the installation database and current writer. */
export const graphChanges = sqliteTable(
  "graph_changes",
  {
    userId: text().notNull(),
    requestKey: text().notNull(),
    hash: text().notNull(),
    attempt: text().notNull(),
    receipt: text({ mode: "json" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.requestKey] })],
);

/** Confirmations are authenticated receipts for an exact assertion revision. */
export const graphAssertionConfirmations = sqliteTable(
  "graph_assertion_confirmations",
  {
    assertionId: text()
      .notNull()
      .references(() => graphNodes.id),
    assertionRevision: integer().notNull(),
    userId: text().notNull(),
    assertionHash: text().notNull(),
    subjectHash: text().notNull(),
    assertionBody: text({ mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull(),
    subjectSnapshot: text({ mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull(),
    confirmedAt: integer().notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.assertionId, t.assertionRevision, t.subjectHash, t.userId],
    }),
  ],
);

import { proposalTables } from "@ai-outfitter/app-sdk/proposal-tables";
export const { proposals: actionProposals, guard: actionGuard } =
  proposalTables("wiki_map_proposals", "wiki_map_agent_guard");

/** Staged Wiki changes (docs/plans/wiki-change-batches.md); invisible to graph reads. */
export const graphBatches = sqliteTable("graph_batches", {
  id: text().primaryKey(),
  title: text().notNull(),
  purpose: text().notNull().default(""),
  source: text({ mode: "json" }).$type<Record<string, unknown> | null>(),
  policy: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
  state: text().notNull(),
  summary: text(),
  openedBy: text().notNull(),
  openedVia: text().notNull(),
  reviewBy: integer(),
  commits: integer().notNull().default(0),
  createdAt: integer().notNull(),
  updatedAt: integer().notNull(),
  expiresAt: integer().notNull(),
  closedAt: integer(),
  /** The ontology steward's latest advisory review (server/batch-review.ts). */
  review: text({ mode: "json" }).$type<BatchReview>(),
  reviewJobId: text(),
  /** Node ids every created node must connect to before the batch can be submitted. */
  anchors: text({ mode: "json" }).$type<string[]>(),
});

export const ontoReviewJobs = sqliteTable("onto_review_jobs", {
  id: text().primaryKey(),
  batchId: text().notNull().references(() => graphBatches.id),
  contentDigest: text().notNull(),
  state: text().notNull(),
  attempts: integer().notNull().default(0),
  leaseId: text(),
  leaseUntil: integer(),
  nextAttemptAt: integer().notNull(),
  createdAt: integer().notNull(),
  error: text(),
}, (t) => [index("onto_review_jobs_due").on(t.state, t.nextAttemptAt, t.leaseUntil)]);

export const graphBatchOperations = sqliteTable(
  "graph_batch_operations",
  {
    batchId: text().notNull().references(() => graphBatches.id),
    ref: text().notNull(),
    position: integer().notNull(),
    operation: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    evidence: text({ mode: "json" }).$type<unknown[]>().notNull().default([]),
    confidence: real(),
    reason: text(),
    state: text().notNull(),
    decidedBy: text(),
    decision: text(),
    recordId: text(),
    recordRevision: integer(),
  },
  (t) => [primaryKey({ columns: [t.batchId, t.ref] })],
);

/** One row per committed revision from the batches migration onward. */
export const graphRevisions = sqliteTable(
  "graph_revisions",
  {
    kind: text().notNull(),
    recordId: text().notNull(),
    revision: integer().notNull(),
    batchId: text(),
    ref: text(),
    proposedBy: text().notNull(),
    approval: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    evidence: text({ mode: "json" }).$type<unknown[]>().notNull().default([]),
    snapshot: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    prior: text({ mode: "json" }).$type<Record<string, unknown> | null>(),
    createdAt: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.recordId, t.revision] })],
);

/** Saved views of the graph people and agents share (docs/graph-explorer.md).
 * A view holds steps, never facts: every read rebuilds its picture from current records. */
export const graphExplorations = sqliteTable("graph_explorations", {
  slug: text().primaryKey(),
  title: text().notNull(),
  /** { start, steps, hidden, focus, direction } (server/explorations.ts). */
  state: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
  revision: integer().notNull(),
  /** Who made the latest change, one line, and the node keys it touched. */
  lastChange: text({ mode: "json" }).$type<Record<string, unknown> | null>(),
  createdBy: text().notNull(),
  createdAt: integer().notNull(),
  updatedAt: integer().notNull(),
});
