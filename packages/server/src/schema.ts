import type { WorkflowPackage } from "@ai-outfitter/workflow-core/artifact";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Identity and tenancy tables: who is asking and which tenant a host is.
 * @ai-outfitter/server owns them because its queries read them; the webapp's
 * src/db/schema.ts re-exports them for its foreign keys and Better Auth.
 */
export const user = sqliteTable("user", {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: integer({ mode: "boolean" }).notNull().default(false),
  adminCreated: integer({ mode: "boolean" }).notNull().default(false),
  // Null preserves legacy ADMIN_GITHUB_IDS bootstrap until an admin saves a role.
  role: text({ enum: ["user", "admin"] }),
  image: text(),
  // Extensible personal context; server-owned, never writable through auth forms.
  profile: text({ mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
  createdAt: integer({ mode: "timestamp_ms" }).notNull(),
  updatedAt: integer({ mode: "timestamp_ms" }).notNull(),
});

export const session = sqliteTable(
  "session",
  {
    id: text().primaryKey(),
    token: text().notNull().unique(),
    expiresAt: integer({ mode: "timestamp_ms" }).notNull(),
    createdAt: integer({ mode: "timestamp_ms" }).notNull(),
    updatedAt: integer({ mode: "timestamp_ms" }).notNull(),
    ipAddress: text(),
    userAgent: text(),
    activeOrganizationId: text(),
    ssoProviderId: text(),
    ssoAuthenticatedAt: integer(),
    ssoPolicyHash: text(),
    // Session claims (src/lib/session-claims.ts): slow-changing authorization
    // facts mirrored into the signed cookie cache. Null means "not claimed";
    // readers fall back to the database.
    /**
     * Unused since sign-up opened. Kept so the Worker running during a deploy,
     * which still reads it, works after migrations apply; drop it in a later release.
     */
    approved: integer({ mode: "boolean" }),
    admin: integer({ mode: "boolean" }),
    orgs: text(),
    claimsVersion: text(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

export const organization = sqliteTable("organization", {
  id: text().primaryKey(),
  name: text().notNull(),
  slug: text().notNull().unique(),
  logo: text(),
  metadata: text(),
  // Platform-administered. Demo organizations accept only demo packages and
  // cannot run agents or use connector credentials. Added by an additive
  // migration, so values are validated in code rather than a table rebuild.
  purpose: text({ enum: ["operational", "demo"] })
    .notNull()
    .default("operational"),
  isDesignPartner: integer({ mode: "boolean" }).notNull().default(false),
  // Extensible shared context, validated and written by the organization profile service.
  profile: text({ mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
  createdAt: integer({ mode: "timestamp_ms" }).notNull(),
});

export const member = sqliteTable(
  "member",
  {
    id: text().primaryKey(),
    organizationId: text()
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text().notNull().default("member"),
    createdAt: integer({ mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("member_org_user_idx").on(t.organizationId, t.userId),
    index("member_user_idx").on(t.userId),
  ],
);

export const organizationAccessPolicies = sqliteTable(
  "organization_access_policies",
  {
    organizationId: text().primaryKey().references(() => organization.id, { onDelete: "cascade" }),
    allowedDomains: text({ mode: "json" }).$type<string[]>().notNull(),
    approvedEmails: text({ mode: "json" }).$type<string[]>().notNull(),
    updatedAt: integer({ mode: "timestamp_ms" }).notNull(),
  },
);

// An exact customer hostname attached to one organization. Rows are never
// deleted: a tombstone keeps the hostname reserved, and reuse bumps generation.
export const organizationDomains = sqliteTable(
  "organization_domains",
  {
    id: text().primaryKey(),
    hostname: text().notNull().unique(),
    organizationId: text()
      .notNull()
      .references(() => organization.id),
    generation: integer().notNull().default(1),
    lifecycle: text({
      enum: ["reserved", "creating", "provisioned", "deleting", "deleted"],
    }).notNull(),
    routingEnabled: integer({ mode: "boolean" }).notNull().default(false),
    verifiedAt: integer(),
    proofToken: text().notNull(),
    proofVerifiedAt: integer(),
    proofCheckedAt: integer(),
    cloudflareId: text(),
    hostnameStatus: text(),
    sslStatus: text(),
    // Sanitized Cloudflare ownership/SSL records and errors, as JSON.
    validation: text({ mode: "json" }).$type<Record<string, unknown>>(),
    routingRecord: text(),
    operationStartedAt: integer(),
    leaseUntil: integer().notNull().default(0),
    version: integer().notNull().default(0),
    attempts: integer().notNull().default(0),
    lastError: text(),
    lastCheckedAt: integer(),
    nextCheckAt: integer().notNull().default(0),
    createdBy: text().notNull(),
    createdAt: integer().notNull(),
    updatedAt: integer().notNull(),
    deletedAt: integer(),
  },
  (t) => [
    index("organization_domains_org_idx").on(t.organizationId),
    index("organization_domains_check_idx").on(t.nextCheckAt),
    check(
      "organization_domains_lifecycle",
      sql`${t.lifecycle} in ('reserved','creating','provisioned','deleting','deleted')`,
    ),
    check(
      "organization_domains_routing",
      sql`${t.routingEnabled} = 0 or ${t.lifecycle} = 'provisioned'`,
    ),
  ],
);

// A host-only credential for one domain generation, derived from a canonical session.
export const domainSessions = sqliteTable(
  "domain_sessions",
  {
    id: text().primaryKey(),
    tokenHash: text().notNull().unique(),
    domainId: text()
      .notNull()
      .references(() => organizationDomains.id),
    generation: integer().notNull(),
    organizationId: text().notNull(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    sourceSessionId: text()
      .notNull()
      .references(() => session.id, { onDelete: "cascade" }),
    expiresAt: integer().notNull(),
    revokedAt: integer(),
    createdAt: integer().notNull(),
  },
  (t) => [
    index("domain_sessions_source_idx").on(t.sourceSessionId),
    index("domain_sessions_domain_idx").on(t.domainId),
  ],
);

export const appInstallations = sqliteTable(
  "app_installations",
  {
    id: text().primaryKey(),
    // Exactly one owner, an organization or a single user (CHECK below):
    // two plain foreign keys, never a polymorphic owner column.
    organizationId: text().references(() => organization.id, {
      onDelete: "cascade",
    }),
    userId: text().references(() => user.id, { onDelete: "cascade" }),
    template: text().notNull(),
    // The app's address segment (`/apps/<slug>/`, `/o/<org>/<slug>/`) when it
    // differs from the template; NULL means the template is the slug. The
    // owner edits it in the installation's settings (src/lib/app-slugs.ts).
    slug: text(),
    // Unique when set; a path-served installation has no hostname.
    hostname: text().unique(),
    activeScript: text(),
    activeHash: text(),
    // Trusted manifest of the active content-addressed package.
    capabilities: text({ mode: "json" }).$type<string[]>().notNull().default([]),
    workflowPackages: text({ mode: "json" }).$type<WorkflowPackage[]>().notNull().default([]),
    // Package mode of the active revision. NULL is a legacy, unclassified
    // installation: never treated as operational.
    mode: text({ enum: ["demo", "operational"] }),
    revision: integer().notNull().default(0),
    // The installation's own D1 database, for an app that keeps its records
    // there (docs/app-databases.md). Created on its first operational deploy.
    databaseId: text(),
    // The installation's own R2 buckets by manifest bucket key, for an app
    // that declares storage (docs/app-storage.md). Created at deploy.
    storageBuckets: text({ mode: "json" }).$type<Record<string, string>>().notNull().default({}),
    createdAt: integer().notNull(),
  },
  (t) => [
    // One installation of a template per owner. SQLite treats NULLs as
    // distinct, so each index binds only its own owner's rows while staying
    // a plain index that ON CONFLICT(organizationId, template) can target.
    uniqueIndex("app_installation_template_idx").on(
      t.organizationId,
      t.template,
    ),
    uniqueIndex("app_installation_user_template_idx").on(t.userId, t.template),
    // One app per address per owner, counting a NULL slug as its template.
    uniqueIndex("app_installation_slug_idx").on(
      t.organizationId,
      sql.raw("(CASE WHEN slug IS NULL THEN template ELSE slug END)"),
    ),
    uniqueIndex("app_installation_user_slug_idx").on(
      t.userId,
      sql.raw("(CASE WHEN slug IS NULL THEN template ELSE slug END)"),
    ),
    check(
      "app_installation_owner",
      sql`(${t.organizationId} IS NULL) <> (${t.userId} IS NULL)`,
    ),
  ],
);
