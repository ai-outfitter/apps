export { graphChangeReceipts } from "@ai-outfitter/app-sdk/batch-receipts";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const foundryRequests = sqliteTable("foundry_requests", {
  id: text().primaryKey(), createdBy: text("created_by").notNull(), kind: text().notNull(),
  title: text().notNull(), payload: text().notNull(), fingerprint: text().notNull(),
  issueUrl: text("issue_url"), createdAt: integer("created_at").notNull(),
});

// Software Foundry projects in the installation's own database: a named group
// of repositories. Position orders projects (0 is the highest priority) and
// `milestones` ranks the project's milestones by title, most important first;
// a title spans the project's repositories. User IDs name platform users and
// are not foreign keys. Generate migrations with
// `npm run db:generate:app -- software-foundry`.
export const foundryProjects = sqliteTable(
  "foundry_projects",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    position: integer().notNull(),
    repositories: text({ mode: "json" })
      .$type<string[]>()
      .notNull()
      .default([]),
    milestones: text({ mode: "json" }).$type<string[]>().notNull().default([]),
    revision: integer().notNull().default(1),
    createdBy: text(),
    updatedBy: text(),
    createdAt: integer().notNull(),
    updatedAt: integer().notNull(),
  },
  (t) => [
    uniqueIndex("foundry_projects_name_idx").on(t.name),
    index("foundry_projects_position_idx").on(t.position),
  ],
);

// Durable caller-scoped intake receipts. A claimed external write is never
// automatically repeated after an uncertain crash: provider reconciliation must
// positively locate its marker first.
export const workSubmissions = sqliteTable(
  "work_submissions",
  {
    key: text().primaryKey(),
    requestId: text().notNull(),
    payloadDigest: text().notNull(),
    payload: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    repository: text().notNull(),
    issue: text({ mode: "json" }).$type<{
      number: number;
      url: string;
      created: boolean;
    }>(),
    createdAt: integer().notNull(),
  },
  (t) => [index("work_submissions_request_idx").on(t.requestId)],
);

import { proposalTables } from "@ai-outfitter/app-sdk/proposal-tables";
export const { proposals: actionProposals, guard: actionGuard } =
  proposalTables("software_foundry_proposals", "software_foundry_agent_guard");

/** Short-lived, identity-bound upload capabilities for immutable evidence assets. */
export const releaseEvidenceUploads = sqliteTable("foundry_release_evidence_uploads", {
  key:text().primaryKey(), token:text().notNull(), installationId:text().notNull(),createdBy:text().notNull(),
  actor:text().notNull(),originActor:text().notNull(),bundle:text().notNull(),path:text().notNull(),
  metadata:text().notNull(),fingerprint:text().notNull(),expiresAt:integer().notNull(),createdAt:integer().notNull(),
},row=>[uniqueIndex("foundry_evidence_upload_token").on(row.token),uniqueIndex("foundry_evidence_upload_target").on(row.bundle,row.path)]);
