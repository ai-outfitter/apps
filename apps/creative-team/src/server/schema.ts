export { graphChangeReceipts } from "@ai-outfitter/app-sdk/batch-receipts";
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// This installation's own database (docs/app-databases.md): one brand per
// installation. Install it personally for your own brand, or once per client in an
// organization. User IDs name platform users and are not foreign keys. After
// changing it, run `npx drizzle-kit generate` in this app and commit the migration.

/** The brand document: one answer per interview question (src/lib/brand.ts). */
export const brandAnswers = sqliteTable("brand_answers", {
  id: text().primaryKey(),
  answer: text().notNull().default(""),
  revision: integer().notNull().default(1),
  updatedBy: text(),
  updatedAt: integer().notNull(),
});

/**
 * The content document's sources: the creator's own best posts on a platform, or a
 * person who shaped their thinking. `examples` holds posts or quotes the member
 * pasted; `notes` what makes them unique: core ideas, voice and worldview.
 */
export const sources = sqliteTable(
  "sources",
  {
    id: text().primaryKey(),
    kind: text().notNull(),
    name: text().notNull(),
    platform: text().notNull().default(""),
    handle: text().notNull().default(""),
    url: text().notNull().default(""),
    examples: text().notNull().default(""),
    notes: text().notNull().default(""),
    revision: integer().notNull().default(1),
    updatedBy: text(),
    createdAt: integer().notNull(),
    updatedAt: integer().notNull(),
  },
  (t) => [check("sources_kind_check", sql`${t.kind} IN ('own', 'influence')`)],
);

/** The content document's synthesis across every source (one row, id "content"). */
export const contentProfile = sqliteTable("content_profile", {
  id: text().primaryKey(),
  coreIdeas: text().notNull().default(""),
  voice: text().notNull().default(""),
  worldview: text().notNull().default(""),
  patterns: text().notNull().default(""),
  revision: integer().notNull().default(1),
  updatedBy: text(),
  updatedAt: integer().notNull(),
});

/**
 * The content map, one row per node: pillars branch into topics, topics into ideas,
 * ideas into angles. `research` is what the idea is based on (a reference post, a
 * pattern seen performing), as the member or assistant recorded it.
 */
export const mapNodes = sqliteTable(
  "map_nodes",
  {
    id: text().primaryKey(),
    parentId: text(),
    level: text().notNull(),
    title: text().notNull(),
    notes: text().notNull().default(""),
    research: text().notNull().default(""),
    position: integer().notNull().default(0),
    revision: integer().notNull().default(1),
    updatedBy: text(),
    createdAt: integer().notNull(),
    updatedAt: integer().notNull(),
  },
  (t) => [
    index("map_nodes_parent_idx").on(t.parentId, t.position),
    check("map_nodes_level_check", sql`${t.level} IN ('pillar', 'topic', 'idea', 'angle')`),
  ],
);

/** Posts drafted from the map, for the member to rewrite and post themselves. */
export const drafts = sqliteTable(
  "drafts",
  {
    id: text().primaryKey(),
    nodeId: text(),
    format: text().notNull(),
    title: text().notNull(),
    body: text().notNull().default(""),
    status: text().notNull().default("draft"),
    revision: integer().notNull().default(1),
    updatedBy: text(),
    createdAt: integer().notNull(),
    updatedAt: integer().notNull(),
  },
  (t) => [
    index("drafts_status_idx").on(t.status, t.updatedAt),
    check("drafts_status_check", sql`${t.status} IN ('draft', 'ready', 'posted', 'archived')`),
  ],
);

/** Change batches this app staged in the member's Wiki, newest last; the Wiki decides what commits. */
export const wikiBatches = sqliteTable(
  "wiki_batches",
  {
    id: text().primaryKey(),
    wikiInstallationId: text().notNull(),
    /** The Wiki's address, for a link to its review page. */
    wikiPath: text().notNull(),
    state: text().notNull(),
    proposals: integer().notNull(),
    createdBy: text(),
    createdAt: integer().notNull(),
    updatedAt: integer().notNull(),
  },
  (t) => [index("wiki_batches_created_idx").on(t.createdAt)],
);
