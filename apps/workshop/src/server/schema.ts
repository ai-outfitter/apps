export { graphChangeReceipts } from "@ai-outfitter/app-sdk/batch-receipts";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Workshop projects in the installation's own database. `data` is the whole
// project document (src/lib/project.ts); the other columns serve listing and
// revision checks. User IDs name platform users and are not foreign keys.
// Generate migrations with `npm run db:generate:app -- workshop`.
export const workshopProjects = sqliteTable(
  "workshop_projects",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    revision: integer().notNull(),
    data: text().notNull(),
    // The Wiki ProductRevision the project builds, copied from `data` so
    // graph.graphql can serve and filter it.
    wikiInstallationId: text(),
    productRevisionId: text(),
    productRevisionTitle: text(),
    createdBy: text().notNull(),
    updatedBy: text().notNull(),
    createdAt: text().notNull(),
    updatedAt: text().notNull(),
  },
  (t) => [
    index("workshop_projects_updated_idx").on(t.updatedAt),
    index("workshop_projects_product_revision_idx").on(t.productRevisionId),
  ],
);

// Physical units in stock, one row per device. Devices with a radio are told
// apart by MAC address (stored upper-case, colon-separated); other parts may
// carry a serial. `partNumber` names an item in a project's assembly, so a unit
// can exist before any project uses it.
export const workshopUnits = sqliteTable(
  "workshop_units",
  {
    id: text().primaryKey(),
    partNumber: text().notNull(),
    mpn: text().notNull(),
    mac: text().unique(),
    serial: text(),
    status: text({ enum: ["in-stock", "allocated", "installed", "retired"] }).notNull(),
    location: text().notNull(),
    /** The project whose build holds this unit, if any. */
    projectId: text(),
    /** The firmware ref last flashed, such as a tag or commit. */
    firmware: text().notNull(),
    notes: text().notNull(),
    revision: integer().notNull(),
    createdBy: text().notNull(),
    updatedBy: text().notNull(),
    createdAt: text().notNull(),
    updatedAt: text().notNull(),
  },
  (t) => [index("workshop_units_part_idx").on(t.partNumber)],
);
