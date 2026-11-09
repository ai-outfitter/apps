/** Planning's local seed adapter for `node scripts/dev-local.mjs`. Node-only; never
 * imported by app pages or packaged workers. It seeds only the viewer's personal
 * installation: each `projects` entry in `personal.local.json` becomes a canonical
 * Planning project with the same ID, which the personal Wiki's Project page
 * references. Organization installations start with the package's own records.
 * Nothing here writes to the data directory. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { appWorker } from "@ai-outfitter/app-test/worker";
import { issueFields, projectFields } from "../src/server/fields";

export const PERSONAL_SEED_FILE = "personal.local.json";
/** The installation trigger's limit (migrations/0000): more fails instead of truncating. */
export const PROJECT_LIMIT = 100;

type Database = Awaited<ReturnType<typeof appWorker>>["database"];
type PersonalContext = { dataDirectory: string; seed: unknown; installations: Record<string, string> };
type Organization = { sourceId: string; slug: string };

const SNAPSHOT_FORMAT = "outfitter-planning-local-v1";
const audit = {
  revision: z.number().int().positive(),
  createdBy: z.string().min(1),
  updatedBy: z.string().min(1),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
};
const organizationSnapshot = z.strictObject({
  format: z.literal(SNAPSHOT_FORMAT),
  sourceInstallationId: z.uuid(),
  // Exports from before projects could be archived have no `archived`; D1 stores it as 0 or 1.
  projects: z.array(projectFields.extend({ id: z.uuid(), archived: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional(), ...audit })),
  issues: z.array(issueFields.extend({ id: z.uuid(), position: z.number().int().nonnegative(), ...audit })),
});

const snapshotPath = (dataDirectory: string, slug: string) =>
  join(dataDirectory, "app-snapshots", slug, "planning.json");

async function organizationPlan(dataDirectory: string, organization: Organization) {
  const path = snapshotPath(dataDirectory, organization.slug);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed = organizationSnapshot.safeParse(JSON.parse(raw));
  if (!parsed.success)
    throw new Error(`${path} is not a supported Planning snapshot: ${z.prettifyError(parsed.error)}`);
  const ids = new Set(parsed.data.projects.map((project) => project.id));
  const issueIds = new Set(parsed.data.issues.map((issue) => issue.id));
  if (ids.size !== parsed.data.projects.length || issueIds.size !== parsed.data.issues.length)
    throw new Error(`${path} repeats a project or issue ID`);
  for (const issue of parsed.data.issues) {
    if (!ids.has(issue.projectId)) throw new Error(`${path}: issue ${issue.id} references a missing project`);
    if (issue.parentId && !issueIds.has(issue.parentId))
      throw new Error(`${path}: issue ${issue.id} references a missing parent`);
  }
  return { path, data: parsed.data };
}

export async function inspectLocalData({
  dataDirectory,
  organizations,
}: {
  dataDirectory: string;
  seed: unknown;
  organizations: Organization[];
}) {
  const installations: Record<string, { source: string; counts: Record<string, number>; notices: string[] }> = {};
  for (const organization of organizations) {
    const planned = await organizationPlan(dataDirectory, organization);
    if (planned)
      installations[organization.sourceId] = {
        source: planned.path,
        counts: { projects: planned.data.projects.length, issues: planned.data.issues.length },
        notices: [],
      };
  }
  return { installations, notices: [] };
}

export async function seedLocalInstallation({
  database,
  dataDirectory,
  organization,
}: {
  database: Database;
  dataDirectory: string;
  seed: unknown;
  organization: Organization;
}) {
  const planned = await organizationPlan(dataDirectory, organization);
  if (!planned) return { source: "package records", counts: { projects: 0, issues: 0 }, notices: [] };
  const installationId = `local-${organization.sourceId}-planning`;
  const projectColumns = [
    "id", "installationId", "githubRepository", "name", "goals", "userStories", "pressRelease",
    "demoInstructions", "demoResults", "archived", "revision", "createdBy", "updatedBy", "createdAt", "updatedAt",
  ];
  const issueColumns = [
    "id", "installationId", "projectId", "title", "description", "category", "status", "assigneeId",
    "dueDate", "position", "parentId", "revision", "createdBy", "updatedBy", "createdAt", "updatedAt",
  ];
  const insert = (table: string, columns: string[], row: object) =>
    database
      .prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
      .bind(...columns.map((column) => (row as Record<string, unknown>)[column] ?? null));
  const projects = planned.data.projects.map((project) => ({ ...project, archived: Number(Boolean(project.archived)), installationId }));
  const issues = planned.data.issues.map((issue) => ({ ...issue, installationId }));
  const orderedIssues = [...issues].sort((a, b) => Number(Boolean(a.parentId)) - Number(Boolean(b.parentId)));
  if (projects.length || orderedIssues.length) await database.batch([
    ...projects.map((row) => insert("planning_projects", projectColumns, row)),
    ...orderedIssues.map((row) => insert("planning_issues", issueColumns, row)),
  ]);
  const projectCount = await database
    .prepare("SELECT count(*) AS count FROM planning_projects WHERE installationId = ?")
    .bind(installationId)
    .first<{ count: number }>();
  const issueCount = await database
    .prepare("SELECT count(*) AS count FROM planning_issues WHERE installationId = ?")
    .bind(installationId)
    .first<{ count: number }>();
  if (projectCount?.count !== projects.length || issueCount?.count !== issues.length)
    throw new Error(`${organization.slug}: Planning snapshot was not fully stored`);
  return {
    source: planned.path,
    counts: { projects: projects.length, issues: issues.length },
    notices: [],
  };
}

// Wiki validates the whole file, Project types included; Planning reads only the projects it owns.
const personalProjects = z.looseObject({
  format: z.literal("outfitter-graph-entities-v1"),
  projects: z
    .array(z.looseObject({ id: z.uuid(), title: z.string() }))
    .default([]),
});

function plan(value: unknown) {
  const parsed = personalProjects.safeParse(value);
  if (!parsed.success)
    throw new Error(`${PERSONAL_SEED_FILE} has no valid Planning projects: ${z.prettifyError(parsed.error)}`);
  const { projects } = parsed.data;
  if (projects.length > PROJECT_LIMIT)
    throw new Error(`${PERSONAL_SEED_FILE} has ${projects.length} projects; Planning holds at most ${PROJECT_LIMIT}`);
  if (new Set(projects.map((p) => p.id)).size !== projects.length)
    throw new Error(`${PERSONAL_SEED_FILE} repeats a project ID`);
  return projects.map((project) => {
    const fields = projectFields.safeParse({ name: project.title });
    if (!fields.success)
      throw new Error(`${PERSONAL_SEED_FILE}: project ${project.id} is not a valid Planning project: ${z.prettifyError(fields.error)}`);
    return { id: project.id, ...fields.data };
  });
}

/** Validate the personal projects without writing anything. */
export async function inspectPersonalData({ seed }: PersonalContext) {
  const projects = plan(seed);
  return { source: PERSONAL_SEED_FILE, counts: { projects: projects.length }, notices: [] };
}

/** Create every personal project in one fresh installation and verify each is stored. */
export async function seedPersonalInstallation({
  database,
  seed,
  installationId,
}: PersonalContext & { database: Database; installationId: string }) {
  const projects = plan(seed);
  const now = Date.now();
  const rows = projects.map((project) => ({
    ...project,
    installationId,
    revision: 1,
    createdBy: "local-seed",
    updatedBy: "local-seed",
    createdAt: now,
    updatedAt: now,
  }));
  const columns = Object.keys(rows[0] ?? {});
  if (rows.length)
    await database.batch([
      database
        .prepare(
          `INSERT INTO planning_projects (${columns.join(",")}) SELECT ${columns
            .map((c) => `json_extract(value,'$.${c}')`)
            .join(",")} FROM json_each(?)`,
        )
        .bind(JSON.stringify(rows)),
    ]);
  const { results } = await database
    .prepare("SELECT id FROM planning_projects WHERE installationId = ?")
    .bind(installationId)
    .all<{ id: string }>();
  const stored = new Set(results.map((row) => row.id));
  const missing = projects.filter((p) => !stored.has(p.id)).length;
  if (missing || stored.size !== projects.length)
    throw new Error(`personal Planning: stored ${stored.size} projects, planned ${projects.length}`);
  return { source: PERSONAL_SEED_FILE, counts: { projects: stored.size }, notices: [] };
}
