export { graphChangeReceipts } from "@ai-outfitter/app-sdk/batch-receipts";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  type AnySQLiteColumn,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
const audit = () => ({
  revision: integer().notNull().default(1),
  createdBy: text().notNull(),
  updatedBy: text().notNull(),
  createdAt: integer().notNull(),
  updatedAt: integer().notNull(),
});
export const projects = sqliteTable(
  "planning_projects",
  {
    id: text().primaryKey(),
    installationId: text().notNull(),
    name: text().notNull(),
    archived: integer({ mode: "boolean" }).notNull().default(false),
    state: text({ enum: ["draft", "backlog", "active", "completed", "archived"] }).notNull().default("active"),
    githubRepository: text().notNull().default(""),
    goals: text().notNull().default(""),
    userStories: text().notNull().default(""),
    pressRelease: text().notNull().default(""),
    demoInstructions: text().notNull().default(""),
    demoResults: text().notNull().default(""),
    ...audit(),
  },
  (t) => [index("planning_projects_installation").on(t.installationId)],
);
export const issues = sqliteTable(
  "planning_issues",
  {
    id: text().primaryKey(),
    installationId: text().notNull(),
    projectId: text()
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    title: text().notNull(),
    description: text().notNull().default(""),
    category: text({ enum: ["stone", "pebble", "sand"] }).notNull(),
    status: text({ enum: ["todo", "in-progress", "done"] })
      .notNull()
      .default("todo"),
    assigneeId: text(),
    dueDate: text(),
    position: integer().notNull(),
    parentId: text().references((): AnySQLiteColumn => issues.id, {
      onDelete: "restrict",
    }),
    ...audit(),
  },
  (t) => [
    index("planning_issues_project_order").on(
      t.installationId,
      t.projectId,
      t.category,
      t.position,
    ),
    index("planning_issues_parent").on(t.parentId),
  ],
);
export type Project = typeof projects.$inferSelect;
export type Issue = typeof issues.$inferSelect;

// Reviewed agent proposals and their decision receipts. Conversations and
// transcripts live in the platform thread service; these rows hold only the
// app's domain decision. `threadId` is a reference, never a foreign key: deleting
// a conversation cancels pending rows but keeps applied/uncertain receipts.
export const proposals = sqliteTable(
  "planning_proposals",
  {
    id: text().primaryKey(),
    installationId: text().notNull(),
    /** The member who requested the proposal; only they can review it. */
    ownerId: text().notNull(),
    threadId: text().notNull(),
    turnId: text(),
    /** Stable submission identity: an exact replay returns the existing row. */
    requestKey: text().notNull(),
    payloadDigest: text().notNull(),
    action: text().notNull(),
    projectId: text(),
    revision: integer().notNull().default(1),
    status: text({
      enum: ["pending", "applied", "rejected", "cancelled", "uncertain"],
    })
      .notNull()
      .default("pending"),
    data: text().notNull(),
    receipt: text(),
    decidedBy: text(),
    /** Timeline entry for the decision; null until synced (retryable, idempotent). */
    timelineEntryId: text(),
    createdAt: integer(),
    updatedAt: integer(),
  },
  (t) => [
    uniqueIndex("planning_proposals_request").on(t.installationId, t.requestKey),
    index("planning_proposals_thread").on(t.installationId, t.threadId),
    index("planning_proposals_owner").on(t.installationId, t.ownerId, t.status),
  ],
);
/** In-batch assertion table: a failed guard aborts the whole write batch. */
export const writeGuard = sqliteTable(
  "planning_agent_guard",
  { value: integer().notNull() },
  (t) => [check("planning_agent_atomic", sql`${t.value}=1`)],
);
export type Proposal = typeof proposals.$inferSelect;
export const workSubmissions = sqliteTable("planning_work_submissions", {
  id: text().primaryKey(),
  installationId: text().notNull(),
  projectId: text()
    .notNull()
    .references(() => projects.id, { onDelete: "restrict" }),
  actor: text().notNull(),
  request: text().notNull(),
  snapshot: text().notNull(),
  policy: text().notNull(),
  foundryReceipt: text(),
  observation: text(),
  review: text(),
  accepted: text(),
  revision: integer().notNull().default(1),
  createdAt: integer().notNull(),
});
export const workEvaluations = sqliteTable("planning_work_evaluations", {
  id: text().primaryKey(),
  submissionId: text()
    .notNull()
    .references(() => workSubmissions.id, { onDelete: "restrict" }),
  data: text().notNull(),
});
export const workGuard = sqliteTable("planning_work_guard", {
  value: integer().notNull(),
});


export const intakes = sqliteTable("planning_intakes", { id: text().primaryKey(), installationId: text().notNull(), body: text().notNull(), revision: integer().notNull().default(1), createdAt: integer().notNull() });

// Project-driven delivery (docs/plans/project-delivery-flow.md). Requirements are Planning's own
// records: a stable caller key, a server id and a revision history. Adding one claims nothing about
// approval, implementation or verification.
export const requirements = sqliteTable(
  "planning_requirements",
  {
    id: text().primaryKey(),
    installationId: text().notNull(),
    projectId: text().notNull().references(() => projects.id, { onDelete: "restrict" }),
    key: text().notNull(),
    retired: integer({ mode: "boolean" }).notNull().default(false),
    body: text().notNull(),
    /** Hash of the actionable content only; descriptive edits leave it unchanged. */
    actionDigest: text().notNull(),
    ...audit(),
  },
  (t) => [uniqueIndex("planning_requirements_key").on(t.installationId, t.projectId, t.key)],
);
export const requirementRevisions = sqliteTable(
  "planning_requirement_revisions",
  {
    requirementId: text().notNull().references(() => requirements.id, { onDelete: "restrict" }),
    revision: integer().notNull(),
    projectRevision: integer().notNull(),
    retired: integer({ mode: "boolean" }).notNull().default(false),
    body: text().notNull(),
    actionDigest: text().notNull(),
    createdBy: text().notNull(),
    createdAt: integer().notNull(),
  },
  (t) => [uniqueIndex("planning_requirement_revisions_pk").on(t.requirementId, t.revision)],
);
/** A durable preparation intent, written in the same batch as the project change it follows. */
export const preparations = sqliteTable(
  "planning_preparations",
  {
    id: text().primaryKey(),
    installationId: text().notNull(),
    projectId: text().notNull().references(() => projects.id, { onDelete: "restrict" }),
    projectRevision: integer().notNull(),
    state: text({ enum: ["queued", "dispatched", "dispatch_failed", "running", "prepared", "blocked", "superseded", "failed"] }).notNull(),
    /** The requirement revisions this preparation answers, with what changed. */
    changes: text().notNull(),
    dispatchError: text(),
    plan: text(),
    revision: integer().notNull().default(1),
    createdBy: text().notNull(),
    createdAt: integer().notNull(),
    updatedAt: integer().notNull(),
  },
  (t) => [uniqueIndex("planning_preparations_revision").on(t.installationId, t.projectId, t.projectRevision)],
);
/** A frozen Workshop or Foundry package. Identical content reuses the row; changes add a sequence. */
export const deliveryPackages = sqliteTable(
  "planning_delivery_packages",
  {
    id: text().primaryKey(),
    installationId: text().notNull(),
    projectId: text().notNull().references(() => projects.id, { onDelete: "restrict" }),
    target: text({ enum: ["workshop", "foundry"] }).notNull(),
    sequence: integer().notNull(),
    preparationId: text().notNull(),
    digest: text().notNull(),
    state: text({ enum: ["proposed", "blocked", "submitted", "needs_reassessment", "superseded"] }).notNull(),
    body: text().notNull(),
    receipt: text(),
    supersedes: text(),
    createdAt: integer().notNull(),
    updatedAt: integer().notNull(),
  },
  (t) => [
    uniqueIndex("planning_delivery_packages_digest").on(t.installationId, t.projectId, t.target, t.digest),
    uniqueIndex("planning_delivery_packages_sequence").on(t.installationId, t.projectId, t.target, t.sequence),
  ],
);
// Daily digests: what changed in a project since its previous digest. Each row keeps
// the snapshot it compared against, so the next digest diffs against exactly what
// this one saw; `summary` is the model's narrative, null when inference was unavailable.
export const digests = sqliteTable(
  "planning_digests",
  {
    id: text().primaryKey(),
    installationId: text().notNull(),
    projectId: text()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    runId: text(),
    trigger: text({ enum: ["manual", "schedule"] }).notNull(),
    since: integer(),
    changes: text().notNull(),
    snapshot: text().notNull(),
    summary: text(),
    summaryError: text(),
    createdBy: text().notNull(),
    createdAt: integer().notNull(),
  },
  (t) => [index("planning_digests_project").on(t.installationId, t.projectId, t.createdAt)],
);
export type Digest = typeof digests.$inferSelect;

export const priorityOrder = sqliteTable("planning_priority_order", {
  installationId: text().notNull(),
  kind: text({ enum: ["projects", "products", "portfolio-organizations", "portfolio-projects"] }).notNull(),
  items: text().notNull().default("[]"),
  revision: integer().notNull().default(1),
}, t => [uniqueIndex("planning_priority_order_scope").on(t.installationId, t.kind)]);

/** The organizations this organization's graph records as design partners: a
 * `customer_of` link to it with `design_partner` set. A cache of the graph, which
 * stays canonical: a call from another organization has no workflow host scope to
 * read it, so editors refresh it (RefreshDesignPartners) and accepting reads it again. */
export const designPartners = sqliteTable("planning_design_partners", {
  installationId: text().notNull(),
  organizationId: text().notNull(),
  /** The partner's Organization node title in this graph. */
  name: text().notNull(),
  refreshedAt: integer().notNull(),
}, (t) => [primaryKey({ columns: [t.installationId, t.organizationId] })]);
/** A design partner's feature or bug request, filed from its own organization. It
 * stays here until an editor accepts it (Foundry's RequestChanges files it) or
 * rejects it. */
export const partnerRequests = sqliteTable("planning_partner_requests", {
  id: text().primaryKey(),
  installationId: text().notNull(),
  partnerOrganizationId: text().notNull(),
  /** The partner's own ID for the request; a replay with it returns this row. */
  requestId: text().notNull(),
  /** Who filed it: the partner member and the verified actor, as JSON. */
  submitter: text().notNull(),
  /** kind, title, problem, acceptanceCriteria, bug and productId, as JSON. */
  brief: text().notNull(),
  status: text({ enum: ["proposed", "accepted", "rejected"] }).notNull().default("proposed"),
  reason: text(),
  /** Foundry's filed request once accepted { requestId, kind, issue, run }, as JSON. */
  foundryRequest: text(),
  decidedBy: text(),
  ...audit(),
}, (t) => [uniqueIndex("planning_partner_requests_request").on(t.installationId, t.partnerOrganizationId, t.requestId)]);
export type PartnerRequest = typeof partnerRequests.$inferSelect;
